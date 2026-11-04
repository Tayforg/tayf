import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// h31-deps-1: `npm audit` reads the global advisory database, and the
// Next.js 16.4.5 security release (7 advisories) was not in it:
// GHSA-mfr8-8qww-v76h is published on vercel/next.js with an empty
// patched_versions field and the range ">= 16.3.0", yet
// `gh api /advisories/GHSA-mfr8-8qww-v76h` is a 404. dep-audit.yml stayed
// green on 16.4.3 while 16.4.5 was out; PR #184 found it by reading the
// release notes.
//
// Two gates close that gap. This file is the offline one: package.json and the
// lockfile may never fall below the newest release known to carry a security
// fix. The online one is scripts/next-advisory-check.mjs (dep-audit.yml job
// `next-advisories`), which reads the repository advisories directly.
//
// Do NOT bump Next.js to satisfy this test: raise the floor in the same PR as
// the bump instead.
// ---------------------------------------------------------------------------

// Raise it on every Next.js security release, in the same PR as the bump.
const NEXT_SECURITY_FLOOR = "16.4.5";

const ROOT = resolve(__dirname, "..", "..");

/** Numeric x.y.z compare (split on '.'): negative, 0 or positive like Array.sort. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True for a plain x.y.z (no range operator, no prerelease, no tag). */
function isExactVersion(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const parts = v.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p !== "" && [...p].every((ch) => ch >= "0" && ch <= "9"));
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string } | undefined>;
};

describe("Next.js stays at or above the security floor", () => {
  it("the floor is itself an exact x.y.z", () => {
    expect(isExactVersion(NEXT_SECURITY_FLOOR)).toBe(true);
  });

  it("package.json pins next to an exact version at or above the floor", () => {
    const v = manifest.dependencies?.next;
    expect(isExactVersion(v), `dependencies.next is ${String(v)}`).toBe(true);
    expect(compareVersions(v as string, NEXT_SECURITY_FLOOR)).toBeGreaterThanOrEqual(0);
  });

  it("package.json pins eslint-config-next to an exact version at or above the floor", () => {
    const v = manifest.devDependencies?.["eslint-config-next"];
    expect(isExactVersion(v), `devDependencies.eslint-config-next is ${String(v)}`).toBe(true);
    expect(compareVersions(v as string, NEXT_SECURITY_FLOOR)).toBeGreaterThanOrEqual(0);
  });

  it("package-lock.json resolves next at or above the floor", () => {
    const v = lock.packages["node_modules/next"]?.version;
    expect(isExactVersion(v), `lockfile next is ${String(v)}`).toBe(true);
    expect(compareVersions(v as string, NEXT_SECURITY_FLOOR)).toBeGreaterThanOrEqual(0);
  });
});

describe("the guard's own version compare", () => {
  it("compares each component numerically, not as text", () => {
    expect(compareVersions("16.4.10", "16.4.5")).toBeGreaterThan(0);
    expect(compareVersions("16.10.0", "16.4.5")).toBeGreaterThan(0);
    expect(compareVersions("17.0.0", "16.99.99")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("16.4.5", "16.4.5")).toBe(0);
  });

  it("sorts an older patch, minor or major below the floor", () => {
    expect(compareVersions("16.4.3", "16.4.5")).toBeLessThan(0);
    expect(compareVersions("16.3.9", "16.4.5")).toBeLessThan(0);
    expect(compareVersions("15.9.9", "16.4.5")).toBeLessThan(0);
  });

  it("rejects ranges, tags and prereleases as non-exact", () => {
    for (const v of ["^16.4.5", "~16.4.5", ">=16.4.5", "16.4", "16.4.5-canary.1", "latest", "", "16.4.x", "*"]) {
      expect(isExactVersion(v), v).toBe(false);
    }
    expect(isExactVersion(undefined)).toBe(false);
    expect(isExactVersion("16.4.5")).toBe(true);
  });
});
