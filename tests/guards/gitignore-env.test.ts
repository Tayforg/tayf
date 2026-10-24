import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname, basename } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (edge-hardening, sup-2): every `.env` variant is ignored
// by git EXCEPT the two committed templates (`.env.example`,
// `.env.local.example`).
//
// The old rules (`.env`, `.env.local`, `.env*.local`) left `.env.production`,
// `.env.development`, `.env.test`, `.env.staging`, `.env.preview` and
// `.env.vercel` (what `vercel env pull` writes) one `git add -A` away from a
// public repository. The block is now `.env` / `.env.*` with explicit
// negations for the two templates, plus `supabase/functions/.env*` for the
// Edge Function runtime's own env file.
//
// The verdict comes from git itself (`git check-ignore`), not from parsing
// .gitignore: negation order and last-match-wins are exactly the things a
// text check gets wrong. `--no-index` is REQUIRED: without it git reports a
// path that is already tracked as "not ignored" whatever the rules say, so the
// two tracked templates (and any env file that was committed by mistake)
// would give a verdict about the index rather than about the rules.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

/** Exit 0 = ignored, exit 1 = not ignored; anything else is a real error. */
function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", path], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

function git(args: string[]): string[] {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .filter((l) => l.length > 0);
}

const MUST_BE_IGNORED = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  ".env.staging",
  ".env.preview",
  ".env.vercel",
  ".env.production.local",
  ".env.development.local",
  "supabase/functions/.env",
  "supabase/functions/.env.local",
] as const;

const MUST_STAY_TRACKABLE = [".env.example", ".env.local.example"] as const;

describe("every .env variant is ignored", () => {
  it.each(MUST_BE_IGNORED)("%s is ignored", (p) => {
    expect(isIgnored(p)).toBe(true);
  });

  it("also ignores env files nested in a sub-directory", () => {
    expect(isIgnored("apps/web/.env.production")).toBe(true);
    expect(isIgnored("supabase/.env.staging")).toBe(true);
  });
});

describe("the committed templates are not ignored", () => {
  it.each(MUST_STAY_TRACKABLE)("%s is not ignored", (p) => {
    expect(isIgnored(p)).toBe(false);
  });

  it.each(MUST_STAY_TRACKABLE)("%s is tracked by git", (p) => {
    expect(git(["ls-files", "--", p])).toEqual([p]);
  });
});

describe("the tracked tree holds no ignored env file", () => {
  it("`git ls-files -ci --exclude-standard` lists no .env* path", () => {
    // -c -i = tracked files that the ignore rules would hide. A hit means an
    // env file is committed (or a rule now swallows a template).
    const trackedButIgnored = git(["ls-files", "-ci", "--exclude-standard"]).filter(
      (p) => basename(p).startsWith(".env"),
    );
    expect(trackedButIgnored).toEqual([]);
  });

  it("the only tracked .env* files are templates", () => {
    const tracked = git(["ls-files", "--", ":(glob)**/.env*"]);
    expect(tracked.filter((p) => !/\.example$/.test(p))).toEqual([]);
  });
});

describe("the helper's own verdicts", () => {
  it("is false (not a throw) for an ordinary, non-ignored path", () => {
    expect(isIgnored("package.json")).toBe(false);
    expect(isIgnored("src/env.ts")).toBe(false);
  });

  it("does not treat a look-alike as an env file", () => {
    expect(isIgnored("docs/environment.md")).toBe(false);
    expect(isIgnored("src/lib/env.ts")).toBe(false);
  });
});
