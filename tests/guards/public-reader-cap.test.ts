import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (cold-read resilience, wave 2): the 4 s reader cap
// (`createReaderClient`, src/lib/supabase/server.ts) must stay on every
// user-facing data read listed below. None of these files is reached by a
// cron or webhook (checked by grep when the list was written), so none needs
// a `ReadProfile` option; they hard-wire the capped client. A refactor that
// quietly puts `createServerClient()` back would make a cold read wait the
// full 8 s `statement_timeout` again, and no behavioural test would notice.
//
// This is a source-text sweep (same technique as cron-read-profile.test.ts,
// whose comment-blanking helper is copied below because a test file cannot be
// imported without registering its tests): every file must exist (so a rename
// cannot turn the guard vacuous), must not CALL `createServerClient(` and
// must call `createReaderClient(` at least once. Comments are blanked first,
// so prose that mentions the plain client does not trip it.
//
// Out of scope on purpose: the /api/v1 key plumbing (keys.ts: api_key_touch,
// usage counters) keeps the plain client, because those are writes.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const CAPPED_FILES = [
  "src/lib/clusters/cluster-detail-query.ts",
  "src/lib/clusters/topic-query.ts",
  "src/lib/clusters/timeline-query.ts",
  "src/lib/clusters/story-timeline-query.ts",
  "src/lib/story-threads/public-query.ts",
  "src/lib/weekly/weekly-query.ts",
  "src/lib/weekly/week-archive.ts",
  "src/lib/weekly/distinctive-words-query.ts",
  "src/app/api/v1/sources/route.ts",
  "src/app/api/v1/sources/[slug]/profile/route.ts",
  "src/app/api/v1/clusters/route.ts",
  "src/app/api/v1/clusters/[id]/route.ts",
  "src/app/api/v1/kap/pickup/route.ts",
  "src/lib/trends/rising-query.ts",
  "src/lib/sources/registry-query.ts",
  "src/lib/entities/entity-hub-query.ts",
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
const CAPPED_CALL = /\bcreateReaderClient\s*\(/;

describe("public reader files keep the capped client", () => {
  it("lists exactly the 16 files the wave covers", () => {
    expect(new Set(CAPPED_FILES).size).toBe(16);
  });

  it.each(CAPPED_FILES)("%s exists (the sweep is not vacuous)", (rel) => {
    expect(existsSync(resolve(ROOT, rel))).toBe(true);
  });

  it.each(CAPPED_FILES)("%s never calls createServerClient()", (rel) => {
    const src = blankComments(readFileSync(resolve(ROOT, rel), "utf8"));
    expect(src).not.toMatch(PLAIN_CALL);
  });

  it.each(CAPPED_FILES)("%s calls createReaderClient()", (rel) => {
    const src = blankComments(readFileSync(resolve(ROOT, rel), "utf8"));
    expect(src).toMatch(CAPPED_CALL);
  });
});

describe("the sweep's own matchers", () => {
  it("flags a real plain-client call and a real capped-client call", () => {
    expect(PLAIN_CALL.test("const s = createServerClient();")).toBe(true);
    expect(PLAIN_CALL.test("const s = createServerClient({ timeoutMs: 1 });")).toBe(true);
    expect(CAPPED_CALL.test("const s = createReaderClient();")).toBe(true);
  });

  it("ignores prose in comments but not code", () => {
    const src = [
      "// do not use createServerClient() here",
      "/* createServerClient() */",
      "const s = createReaderClient();",
    ].join("\n");
    const blanked = blankComments(src);
    expect(blanked).not.toMatch(PLAIN_CALL);
    expect(blanked).toMatch(CAPPED_CALL);
    expect(blankComments("const s = createServerClient(); // ok")).toMatch(PLAIN_CALL);
  });

  it("does not mistake an import specifier or a longer identifier for a call", () => {
    expect(PLAIN_CALL.test('import { createServerClient } from "@/lib/supabase/server";')).toBe(false);
    expect(PLAIN_CALL.test("const s = createServerClientFactory();")).toBe(false);
    expect(CAPPED_CALL.test("const s = mycreateReaderClient();")).toBe(false);
  });
});
