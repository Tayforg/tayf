import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (game-integrity): a route that MINTS an anonymous signed
// session must also consult the fleet-wide DB throttle.
//
// Why: Çerçeve counts a vote only for a cookie this server signed
// (framing-session.ts), so the one way to farm votes is to keep minting fresh
// sessions: discard the cookie, get a new id, a new unique
// (article_id, session_hash) slot. Signing stops clients choosing ids; only a
// per-client cap on NEW sessions (the `cerceve:mint` bucket, migration 118's
// api_throttle) bounds the farming. A new route that calls mintSignedSession()
// without checkDbThrottle() would reopen exactly that hole.
//
// Source-text sweep over src/app/api (non-test files). Comments are blanked
// first (helper copied from rate-limit-429.test.ts: a test file cannot be
// imported without registering its tests), so prose that mentions either name
// can neither trip nor satisfy the check. The matchers need a call paren, so an
// import specifier or a longer identifier is not a call.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const API = resolve(ROOT, "src/app/api");

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

const MINT_CALL = /\bmintSignedSession\s*\(/;
const THROTTLE_CALL = /\bcheckDbThrottle\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const isTestFile = (p: string) => /\.test\.(ts|tsx)$/.test(p);

const API_SOURCES = walk(API).filter((f) => !isTestFile(f));

/** Repo-relative paths of API files that mint a session. */
function minters(): string[] {
  return API_SOURCES.filter((f) => MINT_CALL.test(blankComments(readFileSync(f, "utf8"))))
    .map(rel)
    .sort();
}

/** The subset of `files` that mint a session but never call checkDbThrottle. */
function unthrottledMinters(files: readonly string[]): string[] {
  return files.filter((p) => {
    const src = blankComments(readFileSync(resolve(ROOT, p), "utf8"));
    return MINT_CALL.test(src) && !THROTTLE_CALL.test(src);
  });
}

describe("every route that mints a signed session calls checkDbThrottle", () => {
  it("scans a plausible number of API files (the walk is not blind)", () => {
    expect(API_SOURCES.length).toBeGreaterThan(20);
  });

  it("discovers both Çerçeve routes as minters (the sweep is not vacuous)", () => {
    const found = minters();
    expect(found).toContain("src/app/api/oyun/cerceve/route.ts");
    expect(found).toContain("src/app/api/oyun/cerceve/next/route.ts");
  });

  it("no minter lacks a checkDbThrottle() call", () => {
    expect(unthrottledMinters(minters())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The vote route's throttle chain (game-integrity + player experience).
//
// A counted vote is bounded THREE ways: `cerceve:vote` (total per client),
// `cerceve:art:<article>` (per client, per headline: this is what bounds a
// crowd split, because the signed session cookie carries no expiry and one IP
// can hold many valid ones) and `cerceve:mint` (new sessions). And a full DB
// bucket must NEVER answer 429: it would tell a script when to rotate IPs, and
// the shared bucket (office, school, CGNAT) would drop honest players' tally
// reveal. The only 429 allowed is the in-memory burst limiter's.
// ---------------------------------------------------------------------------

const VOTE_ROUTE = "src/app/api/oyun/cerceve/route.ts";
const POLICY_REFS = ["cerceveVote", "cerceveArticlePrefix", "cerceveMint"] as const;

/** Names of THROTTLE_POLICY keys the source reads. */
function policyRefs(src: string): string[] {
  return [...src.matchAll(/\bTHROTTLE_POLICY\.(\w+)/g)].map((m) => m[1] as string);
}

/** Argument text of every apiTooManyRequests(...) call (an import specifier has no paren). */
function tooManyRequestsArgs(src: string): string[] {
  return [...src.matchAll(/\bapiTooManyRequests\s*\(([^)]*)\)/g)].map((m) => (m[1] as string).trim());
}

describe("the Çerçeve vote route's throttle chain", () => {
  const src = () => blankComments(readFileSync(resolve(ROOT, VOTE_ROUTE), "utf8"));

  it("reads the vote, per-headline and mint policies", () => {
    const refs = policyRefs(src());
    for (const name of POLICY_REFS) expect(refs).toContain(name);
  });

  it("its only 429 is the in-memory burst limiter: a full DB bucket never answers apiTooManyRequests", () => {
    expect(tooManyRequestsArgs(src())).toEqual(["rl.retryAfterMs"]);
  });

  it("never turns a denied throttle decision into a Retry-After", () => {
    expect(src()).not.toMatch(/retryAfterSeconds/);
  });
});

describe("the vote-route matchers", () => {
  it("policyRefs sees real reads and ignores comments", () => {
    const blanked = blankComments(
      "// THROTTLE_POLICY.cerceveVote\nconst a = { ...THROTTLE_POLICY.cerceveMint, clientKey: k };",
    );
    expect(policyRefs(blanked)).toEqual(["cerceveMint"]);
  });

  it("tooManyRequestsArgs finds every call, not the import, and flags a DB-driven 429", () => {
    const ok = blankComments(
      'import { apiTooManyRequests } from "@/lib/api/errors";\nreturn noStore(apiTooManyRequests(rl.retryAfterMs));',
    );
    expect(tooManyRequestsArgs(ok)).toEqual(["rl.retryAfterMs"]);

    const bad = blankComments(
      "return noStore(apiTooManyRequests(rl.retryAfterMs));\nreturn noStore(apiTooManyRequests(t.retryAfterSeconds * 1000));",
    );
    expect(tooManyRequestsArgs(bad)).toEqual(["rl.retryAfterMs", "t.retryAfterSeconds * 1000"]);
  });
});

describe("the sweep's own matchers", () => {
  const ok = [
    'import { checkDbThrottle } from "@/lib/api/db-throttle";',
    "const t = await checkDbThrottle({ ...THROTTLE_POLICY.cerceveMint, clientKey: key });",
    "const fresh = await mintSignedSession();",
  ].join("\n");

  it("recognises a real mint call, with or without whitespace before the paren", () => {
    expect(MINT_CALL.test("const fresh = await mintSignedSession();")).toBe(true);
    expect(MINT_CALL.test("await mintSignedSession ()")).toBe(true);
    expect(MINT_CALL.test("await mintSignedSession(\n)")).toBe(true);
  });

  it("does not mistake an import specifier or a longer identifier for a call", () => {
    expect(MINT_CALL.test('import { mintSignedSession } from "@/lib/game/framing-session";')).toBe(false);
    expect(MINT_CALL.test("await remintSignedSession()")).toBe(false);
    expect(MINT_CALL.test("await mintSignedSessions()")).toBe(false);
    expect(THROTTLE_CALL.test('import { checkDbThrottle } from "@/lib/api/db-throttle";')).toBe(false);
    expect(THROTTLE_CALL.test("await uncheckDbThrottle({})")).toBe(false);
  });

  it("a file with both calls passes; a mint without a throttle fails", () => {
    const blanked = blankComments(ok);
    expect(MINT_CALL.test(blanked) && THROTTLE_CALL.test(blanked)).toBe(true);

    const bad = blankComments("const fresh = await mintSignedSession();\nreturn fresh;");
    expect(MINT_CALL.test(bad)).toBe(true);
    expect(THROTTLE_CALL.test(bad)).toBe(false);
  });

  it("a comment cannot satisfy the throttle check nor trip the mint check", () => {
    const commentedThrottle = blankComments(
      "// TODO checkDbThrottle({ bucket })\nconst fresh = await mintSignedSession();",
    );
    expect(MINT_CALL.test(commentedThrottle)).toBe(true);
    expect(THROTTLE_CALL.test(commentedThrottle)).toBe(false);

    const commentedMint = blankComments(
      "/* mintSignedSession() is called elsewhere */\n// mintSignedSession()\nreturn 1;",
    );
    expect(MINT_CALL.test(commentedMint)).toBe(false);
  });

  it("blankComments keeps a URL's // intact and preserves newlines", () => {
    const src = 'const u = "https://example.com"; // note\nconst x = 1;';
    const blanked = blankComments(src);
    expect(blanked).toContain("https://example.com");
    expect(blanked).not.toContain("note");
    expect(blanked.split("\n")).toHaveLength(2);
  });
});
