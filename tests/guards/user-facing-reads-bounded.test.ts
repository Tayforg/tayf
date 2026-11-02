import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt-27 resilience-1): the visitor-path reads below must
// stay bounded. Each of them used the plain `createServerClient()`, which has
// no per-request timeout: undici's headersTimeout is 300 s, so on a stalled
// connection a cold render (/blindspots, /sources, /kaynaklar/durum, the
// cluster page) waited for the platform limit. They now use the "slow reader"
// (`createSlowReaderClient`, 9 s, no postgrest-js retry) or the 4 s
// `createReaderClient`.
//
// Source-text sweep, same technique as public-reader-cap.test.ts (its
// comment-blanking helper is copied because a test file cannot be imported
// without registering its tests): every file must exist (a rename cannot make
// the guard vacuous), must not CALL `createServerClient(` and must call
// `createSlowReaderClient(` or `createReaderClient(` at least once. Comments
// are blanked first so prose that mentions the plain client does not trip it.
//
// None of these files is reached by a cron, admin page or webhook (grep when
// the list was written: footer -> active-count; /sources, /kaynaklar/durum,
// /blindspots, /hafta -> feed-status; /rss.xml, /metodoloji -> headline/status;
// the cluster page -> cluster-fact-checks-query), so none needs a
// `ReadProfile` option.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const BOUNDED_FILES = [
  "src/lib/sources/feed-status.ts",
  "src/lib/sources/active-count.ts",
  "src/app/sources/page.tsx",
  "src/lib/headline/status.ts",
  "src/lib/fact-checks/cluster-fact-checks-query.ts",
] as const;

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

const PLAIN_CALL = /\bcreateServerClient\s*\(/;
const BOUNDED_CALL = /\bcreate(?:Slow)?ReaderClient\s*\(/;

describe("user-facing visitor reads are bounded", () => {
  it("lists exactly the 5 files the fix covers", () => {
    expect(new Set(BOUNDED_FILES).size).toBe(5);
  });

  it.each(BOUNDED_FILES)("%s exists (the sweep is not vacuous)", (rel) => {
    expect(existsSync(resolve(ROOT, rel))).toBe(true);
  });

  it.each(BOUNDED_FILES)("%s never calls createServerClient()", (rel) => {
    const src = blankComments(readFileSync(resolve(ROOT, rel), "utf8"));
    expect(src).not.toMatch(PLAIN_CALL);
  });

  it.each(BOUNDED_FILES)(
    "%s calls createSlowReaderClient() or createReaderClient()",
    (rel) => {
      const src = blankComments(readFileSync(resolve(ROOT, rel), "utf8"));
      expect(src).toMatch(BOUNDED_CALL);
    },
  );
});

describe("the sweep's own matchers", () => {
  it("flags a real plain-client call and real bounded-client calls", () => {
    expect(PLAIN_CALL.test("const s = createServerClient();")).toBe(true);
    expect(PLAIN_CALL.test("const s = createServerClient({ timeoutMs: 1 });")).toBe(true);
    expect(BOUNDED_CALL.test("const s = createReaderClient();")).toBe(true);
    expect(BOUNDED_CALL.test("const s = createSlowReaderClient();")).toBe(true);
  });

  it("ignores prose in comments but not code", () => {
    const src = [
      "// do not use createServerClient() here",
      "/* createServerClient() */",
      "const s = createSlowReaderClient();",
    ].join("\n");
    const blanked = blankComments(src);
    expect(blanked).not.toMatch(PLAIN_CALL);
    expect(blanked).toMatch(BOUNDED_CALL);
    expect(blankComments("const s = createServerClient(); // ok")).toMatch(PLAIN_CALL);
  });

  it("does not count a bounded-client name that only appears in a comment", () => {
    const blanked = blankComments("// createSlowReaderClient() lives in server.ts\nconst s = 1;");
    expect(blanked).not.toMatch(BOUNDED_CALL);
  });

  it("does not mistake an import specifier or a longer identifier for a call", () => {
    expect(PLAIN_CALL.test('import { createServerClient } from "@/lib/supabase/server";')).toBe(false);
    expect(PLAIN_CALL.test("const s = createServerClientFactory();")).toBe(false);
    expect(BOUNDED_CALL.test("const s = mycreateSlowReaderClient();")).toBe(false);
    expect(BOUNDED_CALL.test('import { createSlowReaderClient } from "@/lib/supabase/server";')).toBe(false);
  });
});
