import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACKNOWLEDGED,
  ADVISORIES_URL,
  MAX_PAGES,
  compareVersions,
  evaluate,
  isEntryPoint,
  parsePatchedVersions,
  run,
  satisfiesRange,
} from "./next-advisory-check.mjs";

// h31-deps-1: `npm audit` reads the GLOBAL advisory database, and the Next.js
// 16.4.5 security release was not in it (GHSA-mfr8-8qww-v76h is published on
// vercel/next.js with patched_versions '' and the range '>= 16.3.0', while
// /advisories/GHSA-mfr8-8qww-v76h is a 404). scripts/next-advisory-check.mjs
// reads the repository advisories directly and fails when the installed Next.js
// is covered by one. These tests pin the version maths, the advisory rules and
// the fail-closed transport, all against stub data (no network).

const NEXT_REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// --- compareVersions -------------------------------------------------------------

describe("compareVersions", () => {
  it("compares each component numerically", () => {
    expect(compareVersions("16.4.10", "16.4.5")).toBe(1);
    expect(compareVersions("16.10.0", "16.4.5")).toBe(1);
    expect(compareVersions("16.4.3", "16.4.5")).toBe(-1);
    expect(compareVersions("16.4.5", "16.4.5")).toBe(0);
    expect(compareVersions("17.0.0", "16.99.99")).toBe(1);
  });

  it("sorts a prerelease before its release", () => {
    expect(compareVersions("16.4.5-canary.1", "16.4.5")).toBe(-1);
    expect(compareVersions("16.4.5", "16.4.5-canary.1")).toBe(1);
    expect(compareVersions("16.4.5-rc.0", "16.4.4")).toBe(1);
  });

  it("orders prerelease identifiers the semver way", () => {
    expect(compareVersions("1.0.0-canary.2", "1.0.0-canary.10")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.1")).toBe(0);
  });

  it("ignores build metadata and a leading v", () => {
    expect(compareVersions("16.4.5+build.7", "16.4.5")).toBe(0);
    expect(compareVersions("v16.4.5", "16.4.5")).toBe(0);
  });

  it("completes a short version with zeros", () => {
    expect(compareVersions("16", "16.0.0")).toBe(0);
    expect(compareVersions("16.4", "16.4.1")).toBe(-1);
  });

  it("throws on something that is not a version (never a silent 0)", () => {
    expect(() => compareVersions("latest", "16.4.5")).toThrow();
    expect(() => compareVersions("16.x.5", "16.4.5")).toThrow();
    expect(() => compareVersions("", "16.4.5")).toThrow();
  });
});

// --- satisfiesRange --------------------------------------------------------------

describe("satisfiesRange (GitHub vulnerable_version_range)", () => {
  it("ANDs comma-separated comparators", () => {
    expect(satisfiesRange("16.4.3", ">= 16.0.0, < 16.4.5")).toBe(true);
    expect(satisfiesRange("16.4.5", ">= 16.0.0, < 16.4.5")).toBe(false);
    expect(satisfiesRange("15.9.9", ">= 16.0.0, < 16.4.5")).toBe(false);
    expect(satisfiesRange("16.0.0", ">= 16.0.0, < 16.4.5")).toBe(true);
  });

  it("supports >=, >, <=, < and = (with or without spaces)", () => {
    expect(satisfiesRange("16.3.0", ">= 16.3.0")).toBe(true);
    expect(satisfiesRange("16.2.9", ">= 16.3.0")).toBe(false);
    expect(satisfiesRange("16.3.0", "> 16.3.0")).toBe(false);
    expect(satisfiesRange("16.3.1", ">16.3.0")).toBe(true);
    expect(satisfiesRange("16.3.0", "<= 16.3.0")).toBe(true);
    expect(satisfiesRange("16.3.1", "<= 16.3.0")).toBe(false);
    expect(satisfiesRange("16.3.0", "< 16.3.0")).toBe(false);
    expect(satisfiesRange("15.0.0", "= 15.0.0")).toBe(true);
    expect(satisfiesRange("15.0.1", "= 15.0.0")).toBe(false);
    expect(satisfiesRange("16.0.0", ">=16.0.0,<16.4.5")).toBe(true);
  });

  it("treats a bare version as equality", () => {
    expect(satisfiesRange("15.0.0", "15.0.0")).toBe(true);
    expect(satisfiesRange("15.0.1", "15.0.0")).toBe(false);
  });

  it("splits || as OR, defensively", () => {
    const range = "< 14.2.0 || >= 16.0.0, < 16.4.5";
    expect(satisfiesRange("13.5.0", range)).toBe(true);
    expect(satisfiesRange("15.0.0", range)).toBe(false);
    expect(satisfiesRange("16.4.3", range)).toBe(true);
    expect(satisfiesRange("16.4.5", range)).toBe(false);
  });

  it("puts a prerelease below its release", () => {
    expect(satisfiesRange("16.5.0-canary.1", "< 16.5.0")).toBe(true);
    expect(satisfiesRange("16.5.0-canary.1", ">= 16.5.0")).toBe(false);
  });

  it("treats an empty or missing range as 'every version' (fail closed)", () => {
    expect(satisfiesRange("16.4.5", "")).toBe(true);
    expect(satisfiesRange("16.4.5", "   ")).toBe(true);
    expect(satisfiesRange("16.4.5", null)).toBe(true);
    expect(satisfiesRange("16.4.5", undefined)).toBe(true);
  });

  it("throws on an operator or version it does not understand", () => {
    expect(() => satisfiesRange("16.4.5", "~> 16.4")).toThrow();
    expect(() => satisfiesRange("16.4.5", "^16.4.5")).toThrow();
    expect(() => satisfiesRange("16.4.5", ">=")).toThrow();
    expect(() => satisfiesRange("16.4.5", ">== 16.0.0")).toThrow();
    expect(() => satisfiesRange("16.4.5", ">= banana")).toThrow();
  });
});

// --- the shapes the live feed really holds ----------------------------------------
//
// vulnerable_version_range is free text typed by advisory authors. These are the distinct shapes of
// `GET /repos/vercel/next.js/security-advisories?state=published` for package next on 2026-11-04
// (79 advisories, 147 vulnerability entries; the 85 per-canary exact entries of GHSA-5f7q are one
// shape). A parser that threw on any of them would leave the weekly check permanently red.

const LIVE_RANGES = [
  " >= 16.0.0 < 16.2.11",
  "10.0.0 <= 12.0.10",
  "10.x",
  "15.0.0-canary.0",
  "16.3.0",
  "< 14.2.31, 15.0.0 - 15.4.4",
  "< 16.0.0",
  "<14.2.7",
  "<=11.0.1",
  "<=12.3.5, <=13.5.9, <=14.2.25, <=15.2.3",
  "=> 11.1.4 < 12.3.5",
  "=>14.0 <14.2.25",
  "> 16.0.0 <= 16.4.0",
  ">15.0.4 and <15.2.0",
  ">= 10.0.0  <= 15.5.27",
  ">= 13.0.0 < 14.2.21, >= 15.0.0 < 15.1.1",
  ">= 13.0.0, < 13.5.9",
  ">= 13.3, >= 14, >=15, >=16",
  ">= 13.4 < 15.5.24",
  ">= 16.0.0",
  ">= 16.0.0 < 16.3.?",
  ">= 16.0.0 <= 16.4.0",
  ">= 16.0.0, <= 16.4.2",
  ">= 16.2.0 < 16.3.6",
  ">= v12.2.0 < 15.5.16",
  ">=10.0.0",
  ">=13.0.0 < 15.5.15, >= 16.0 < 16.2.3",
  ">=13.0.0 < 15.5.21",
  ">=13.0.0 <14.2.30, >=15.0.0 <15.2.2",
  ">=13.0.0 <15.0.8, >=15.0.0 <15.6.0-canary.61, >=16.0.0 <16.1.5",
  ">=13.3.1 <13.5",
  ">=13.4 <13.5.1",
  ">=14.3.0-canary.77, >=15, >=16",
  ">=15, >=16",
  ">=16.0.0 <= 16.4.0",
  ">=9.5.5 <=14.2.14",
];

const LIVE_PATCHED = [
  "12.0.5,11.1.3",
  "14.2.30, >= 15.2.2",
  "14.2.35, 15.0.7, 15.1.11, 15.2.8, 15.3.8, 15.4.10, 15.5.9, 15.6.0-canary.60, 16.0.10, 16.1.0-canary.19",
  "15.0.8, 15.1.12, 15.2.9, 15.3.9, 15.4.11, 15.5.10, 15.6.0-canary.61, 16.0.11, 16.1.5",
  "15.1.2, 14.2.21, 13.5.8",
  "15.5.15, 16.2.3",
  "16.0.9, 15.5.8, 15.4.9, 15.3.7, 15.2.7, 15.1.10, 15.0.6, 14.2.34, 15.6.0-canary.59, 16.1.0-canary.17",
  "16.3.?",
  "16.4.2",
  "=>12.3.6, =>13.5.10, =>14.2.26, =>15.2.4",
  ">=13.5",
  ">=14.2.7",
  "v16.0.7, v15.5.7, v15.4.8, v15.3.6, v15.2.6, v15.1.9, v15.0.5, 15.6.0-canary.58, 16.1.0-canary.12",
  "\u226415.0.4 and \u226515.2.0",
];

describe("the live advisory feed's range and patched_versions shapes", () => {
  it.each(LIVE_RANGES)("reads the range %j for 16.4.5 without throwing", (range) => {
    expect(() => satisfiesRange("16.4.5", range)).not.toThrow();
  });

  it.each(LIVE_PATCHED)("reads patched_versions %j into at least one fixed version", (patched) => {
    expect(parsePatchedVersions(patched).length).toBeGreaterThan(0);
  });

  it("understands whitespace-separated comparators (AND), with a double space too", () => {
    expect(satisfiesRange("15.5.27", ">= 10.0.0  <= 15.5.27")).toBe(true);
    expect(satisfiesRange("15.5.28", ">= 10.0.0  <= 15.5.27")).toBe(false);
    expect(satisfiesRange("9.9.9", ">= 10.0.0  <= 15.5.27")).toBe(false);
    expect(satisfiesRange("16.3.0", " >= 16.0.0 < 16.2.11")).toBe(false);
    expect(satisfiesRange("16.2.10", " >= 16.0.0 < 16.2.11")).toBe(true);
  });

  it("reads a comma list as OR when a piece holds several comparators", () => {
    const range = ">=13.0.0 <15.0.8, >=15.0.0 <15.6.0-canary.61, >=16.0.0 <16.1.5";
    expect(satisfiesRange("14.0.0", range)).toBe(true);
    expect(satisfiesRange("15.5.9", range)).toBe(true);
    expect(satisfiesRange("15.6.0", range)).toBe(false);
    expect(satisfiesRange("16.1.4", range)).toBe(true);
    expect(satisfiesRange("16.1.5", range)).toBe(false);
    expect(satisfiesRange("16.4.5", range)).toBe(false);
    expect(satisfiesRange("16.4.5", ">=13.0.0 < 15.5.15, >= 16.0 < 16.2.3")).toBe(false);
    expect(satisfiesRange("16.2.2", ">=13.0.0 < 15.5.15, >= 16.0 < 16.2.3")).toBe(true);
  });

  it("reads a comma list of single comparators as AND, GitHub's own format", () => {
    expect(satisfiesRange("16.4.5", ">= 13.3, >= 14, >=15, >=16")).toBe(true);
    expect(satisfiesRange("15.9.0", ">= 13.3, >= 14, >=15, >=16")).toBe(false);
    expect(satisfiesRange("16.4.5", ">= 16.0.0, <= 16.4.2")).toBe(false);
    expect(satisfiesRange("16.4.2", ">= 16.0.0, <= 16.4.2")).toBe(true);
    expect(satisfiesRange("16.4.5", "<=12.3.5, <=13.5.9, <=14.2.25, <=15.2.3")).toBe(false);
  });

  it("reads => and unicode operators", () => {
    expect(satisfiesRange("12.3.4", "=> 11.1.4 < 12.3.5")).toBe(true);
    expect(satisfiesRange("12.3.5", "=> 11.1.4 < 12.3.5")).toBe(false);
    expect(satisfiesRange("14.2.24", "=>14.0 <14.2.25")).toBe(true);
    expect(satisfiesRange("15.1.0", "\u226515.0.0 <15.2.0")).toBe(true);
    expect(satisfiesRange("15.2.0", "\u226415.2.0")).toBe(true);
  });

  it("reads a bare version followed by an upper bound as a range, and a lone one as equality", () => {
    expect(satisfiesRange("11.0.0", "10.0.0 <= 12.0.10")).toBe(true);
    expect(satisfiesRange("12.0.11", "10.0.0 <= 12.0.10")).toBe(false);
    expect(satisfiesRange("9.9.9", "10.0.0 <= 12.0.10")).toBe(false);
    expect(satisfiesRange("16.3.0", "16.3.0")).toBe(true);
    expect(satisfiesRange("16.3.1", "16.3.0")).toBe(false);
    expect(satisfiesRange("15.0.0-canary.0", "15.0.0-canary.0")).toBe(true);
    expect(satisfiesRange("15.0.0", "15.0.0-canary.0")).toBe(false);
  });

  it("reads hyphen ranges and 'and'", () => {
    const range = "< 14.2.31, 15.0.0 - 15.4.4";
    expect(satisfiesRange("14.2.30", range)).toBe(true);
    expect(satisfiesRange("14.2.31", range)).toBe(false);
    expect(satisfiesRange("15.4.4", range)).toBe(true);
    expect(satisfiesRange("15.4.5", range)).toBe(false);
    expect(satisfiesRange("16.4.5", range)).toBe(false);
    expect(satisfiesRange("15.1.0", ">15.0.4 and <15.2.0")).toBe(true);
    expect(satisfiesRange("15.0.4", ">15.0.4 and <15.2.0")).toBe(false);
  });

  it("reads x and ? wildcards by their written components only", () => {
    expect(satisfiesRange("10.5.1", "10.x")).toBe(true);
    expect(satisfiesRange("11.0.0", "10.x")).toBe(false);
    expect(satisfiesRange("16.4.5", ">= 16.0.0 < 16.3.?")).toBe(false);
    expect(satisfiesRange("16.2.0", ">= 16.0.0 < 16.3.?")).toBe(true);
    expect(satisfiesRange("16.4.5", "16.3.?")).toBe(false);
    expect(satisfiesRange("16.3.9", "16.3.?")).toBe(true);
  });

  it("reads partial versions (16, 16.0) as zero-filled lower bounds", () => {
    expect(satisfiesRange("16.0.0", ">= 16.0 < 16.2.3")).toBe(true);
    expect(satisfiesRange("15.9.9", ">= 16.0 < 16.2.3")).toBe(false);
    expect(satisfiesRange("16.4.5", ">=15")).toBe(true);
  });

  it("parses patched_versions into lower bounds only", () => {
    expect(parsePatchedVersions("\u226415.0.4 and \u226515.2.0")).toEqual(["15.2.0"]);
    expect(parsePatchedVersions("16.1.7, 15.5.13")).toEqual(["16.1.7", "15.5.13"]);
    expect(parsePatchedVersions("v16.0.7, v15.5.7")).toEqual(["16.0.7", "15.5.7"]);
    expect(parsePatchedVersions("14.2.30, >= 15.2.2")).toEqual(["14.2.30", "15.2.2"]);
    expect(parsePatchedVersions("=>12.3.6, =>13.5.10")).toEqual(["12.3.6", "13.5.10"]);
    expect(parsePatchedVersions("16.3.?")).toEqual(["16.3.0"]);
    expect(parsePatchedVersions("12.0.5,11.1.3")).toEqual(["12.0.5", "11.1.3"]);
    expect(parsePatchedVersions("15.6.0-canary.61, 16.0.11")).toEqual(["15.6.0-canary.61", "16.0.11"]);
  });

  it("parses no fixed version out of an empty, missing or upper-bound-only text", () => {
    expect(parsePatchedVersions("")).toEqual([]);
    expect(parsePatchedVersions("  ")).toEqual([]);
    expect(parsePatchedVersions(null)).toEqual([]);
    expect(parsePatchedVersions(undefined)).toEqual([]);
    expect(parsePatchedVersions("<= 16.4.1")).toEqual([]);
  });

  it("throws on a patched_versions text it cannot read", () => {
    expect(() => parsePatchedVersions("banana")).toThrow();
  });
});

// --- evaluate --------------------------------------------------------------------

/** One repository-advisory object, with the vulnerability fields that matter. */
function advisory({ id = "GHSA-test-aaaa-bbbb", range, patched, state = "published", withdrawn = null, pkg = "next", ecosystem = "npm", severity = "high" }) {
  return {
    ghsa_id: id,
    state,
    withdrawn_at: withdrawn,
    severity,
    summary: `summary of ${id}`,
    vulnerabilities: [
      { package: { ecosystem, name: pkg }, vulnerable_version_range: range, patched_versions: patched },
    ],
  };
}

const MFR8 = "GHSA-mfr8-8qww-v76h";
const ACK = {
  [MFR8]: { fixedIn: "16.4.5", reason: "Next.js 16.4.5 release notes list the fix; bumped in PR #184" },
};

describe("evaluate", () => {
  it("passes GHSA-mfr8-8qww-v76h (empty patched_versions) on 16.4.5 when it is acknowledged", () => {
    const a = advisory({ id: MFR8, range: ">= 16.3.0", patched: "" });
    const out = evaluate([a], "16.4.5", ACK);
    expect(out.failures).toEqual([]);
    expect(out.notes.join("\n")).toContain(MFR8);
    expect(out.notes.join("\n")).toContain("#184");
  });

  it("fails GHSA-mfr8-8qww-v76h on 16.4.3 even though it is acknowledged (installed is below fixedIn)", () => {
    const a = advisory({ id: MFR8, range: ">= 16.3.0", patched: "" });
    const out = evaluate([a], "16.4.3", ACK);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain(MFR8);
    expect(out.failures[0]).toContain("16.4.5");
  });

  it("the shipped ACKNOWLEDGED table acknowledges GHSA-mfr8-8qww-v76h as fixed in 16.4.5 with a PR citation", () => {
    const ack = ACKNOWLEDGED[MFR8];
    expect(ack).toBeDefined();
    expect(ack.fixedIn).toBe("16.4.5");
    expect(ack.reason).toContain("#184");
    const a = advisory({ id: MFR8, range: ">= 16.3.0", patched: "" });
    expect(evaluate([a], "16.4.5").failures).toEqual([]);
    expect(evaluate([a], "16.4.3").failures).toHaveLength(1);
  });

  it("fails an unacknowledged advisory with an empty patched_versions that covers the installed version", () => {
    const a = advisory({ id: "GHSA-new-new1-new2", range: ">= 16.3.0", patched: "" });
    const out = evaluate([a], "16.4.5", ACK);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain("GHSA-new-new1-new2");
  });

  it("fails a null or missing patched_versions the same way", () => {
    for (const patched of [null, undefined]) {
      const a = advisory({ id: "GHSA-null-null-null", range: ">= 16.3.0", patched });
      expect(evaluate([a], "16.4.5", ACK).failures).toHaveLength(1);
    }
  });

  it("does not accept an acknowledgement without a reason, or without fixedIn", () => {
    const a = advisory({ id: MFR8, range: ">= 16.3.0", patched: "" });
    expect(evaluate([a], "16.4.5", { [MFR8]: { fixedIn: "16.4.5", reason: "" } }).failures).toHaveLength(1);
    expect(evaluate([a], "16.4.5", { [MFR8]: { reason: "PR #184" } }).failures).toHaveLength(1);
  });

  it("fails '>= 16.0.0, < 16.4.5' (patched 16.4.5) on 16.4.3 and passes it on 16.4.5", () => {
    const a = advisory({ id: "GHSA-aaaa-bbbb-cccc", range: ">= 16.0.0, < 16.4.5", patched: "16.4.5" });
    const bad = evaluate([a], "16.4.3", ACK);
    expect(bad.failures).toHaveLength(1);
    expect(bad.failures[0]).toContain("GHSA-aaaa-bbbb-cccc");
    expect(evaluate([a], "16.4.5", ACK)).toEqual({ failures: [], notes: [] });
  });

  it("passes an advisory for an older major ('>= 15.0.0, < 15.5.7') on 16.4.5", () => {
    const a = advisory({ range: ">= 15.0.0, < 15.5.7", patched: "15.5.7" });
    expect(evaluate([a], "16.4.5", ACK)).toEqual({ failures: [], notes: [] });
  });

  it("ignores a withdrawn advisory", () => {
    const a = advisory({ range: ">= 16.3.0", patched: "", withdrawn: "2026-11-02T10:00:00Z" });
    expect(evaluate([a], "16.4.5", ACK)).toEqual({ failures: [], notes: [] });
  });

  it("ignores an advisory that is not published", () => {
    for (const state of ["draft", "closed", "triage", "withdrawn"]) {
      const a = advisory({ range: ">= 16.3.0", patched: "", state });
      expect(evaluate([a], "16.4.5", ACK), state).toEqual({ failures: [], notes: [] });
    }
  });

  it("ignores a vulnerability of another package or another ecosystem", () => {
    expect(evaluate([advisory({ range: ">= 1.0.0", patched: "", pkg: "react" })], "16.4.5", ACK).failures).toEqual([]);
    expect(evaluate([advisory({ range: ">= 1.0.0", patched: "", pkg: "next", ecosystem: "pip" })], "16.4.5", ACK).failures).toEqual(
      [],
    );
    expect(evaluate([advisory({ range: ">= 1.0.0", patched: "", pkg: "next-auth" })], "16.4.5", ACK).failures).toEqual([]);
  });

  it("looks at every vulnerability of an advisory, not just the first", () => {
    const a = {
      ghsa_id: "GHSA-multi-vuln-0001",
      state: "published",
      withdrawn_at: null,
      severity: "high",
      vulnerabilities: [
        { package: { ecosystem: "npm", name: "react" }, vulnerable_version_range: "< 99.0.0", patched_versions: "99.0.0" },
        { package: { ecosystem: "npm", name: "next" }, vulnerable_version_range: ">= 16.0.0, < 16.4.5", patched_versions: "16.4.5" },
      ],
    };
    expect(evaluate([a], "16.4.3", ACK).failures).toHaveLength(1);
    expect(evaluate([a], "16.4.5", ACK).failures).toEqual([]);
  });

  it("copes with an advisory that has no vulnerabilities array", () => {
    expect(evaluate([{ ghsa_id: "GHSA-none-none-none", state: "published", withdrawn_at: null }], "16.4.5", ACK)).toEqual({
      failures: [],
      notes: [],
    });
  });

  describe("the floor of a non-empty patched_versions", () => {
    it("uses the lowest patched version on the installed major.minor", () => {
      const a = advisory({ range: ">= 14.0.0", patched: "14.2.21, 15.1.9, 16.4.6, 16.4.4, 16.0.9" });
      expect(evaluate([a], "16.4.3", ACK).failures).toHaveLength(1);
      expect(evaluate([a], "16.4.4", ACK).failures).toEqual([]);
    });

    it("falls back to the lowest patched version on the same major", () => {
      const a = advisory({ range: ">= 14.0.0", patched: "14.2.21, 16.1.7, 16.2.4" });
      expect(evaluate([a], "16.0.5", ACK).failures).toHaveLength(1);
      expect(evaluate([a], "16.4.2", ACK).failures).toEqual([]);
    });

    it("falls back to the lowest patched version overall", () => {
      const a = advisory({ range: ">= 14.0.0", patched: "15.5.7, 14.2.21" });
      expect(evaluate([a], "16.4.3", ACK).failures).toEqual([]);
      expect(evaluate([a], "14.0.5", ACK).failures).toHaveLength(1);
    });

    it("adds a 'range over-broad' note when the installed version is in range but past the floor", () => {
      const a = advisory({ id: "GHSA-over-broad-0001", range: ">= 16.0.0", patched: "16.0.9, 16.4.5" });
      const out = evaluate([a], "16.4.5", ACK);
      expect(out.failures).toEqual([]);
      expect(out.notes).toHaveLength(1);
      expect(out.notes[0]).toContain("GHSA-over-broad-0001");
      expect(out.notes[0]).toContain("range over-broad");
    });
  });

  it("fails closed on a range it cannot parse when no fix is recorded", () => {
    const a = advisory({ id: "GHSA-bad-range-0001", range: "~> 16.4", patched: "" });
    const out = evaluate([a], "16.4.5", ACK);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain("GHSA-bad-range-0001");
    expect(out.failures[0]).toContain("range not understood");
  });

  it("treats an unreadable range as covering every version, so the patched floor still decides", () => {
    const a = advisory({ id: "GHSA-bad-range-0002", range: "~> 16.4", patched: "16.4.5" });
    expect(evaluate([a], "16.4.3", ACK).failures).toHaveLength(1);
    const ok = evaluate([a], "16.4.5", ACK);
    expect(ok.failures).toEqual([]);
    expect(ok.notes[0]).toContain("range not understood");
  });

  it("fails closed on a patched_versions text that names no fixed version", () => {
    const a = advisory({ id: "GHSA-bad-patch-0001", range: ">= 16.3.0", patched: "<= 16.4.1" });
    const out = evaluate([a], "16.4.5", ACK);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toContain("names no fixed version");
    const garbled = advisory({ id: "GHSA-bad-patch-0002", range: ">= 16.3.0", patched: "banana" });
    expect(evaluate([garbled], "16.4.5", ACK).failures).toHaveLength(1);
  });

  it("reports one line per in-range advisory and nothing for the rest", () => {
    const list = [
      advisory({ id: "GHSA-in-range-0001", range: ">= 16.0.0, < 16.4.5", patched: "16.4.5" }),
      advisory({ id: "GHSA-in-range-0002", range: ">= 16.3.0", patched: "" }),
      advisory({ id: "GHSA-old-major-0003", range: "< 15.5.7", patched: "15.5.7" }),
    ];
    const out = evaluate(list, "16.4.3", {});
    expect(out.failures.concat(out.notes)).toHaveLength(2);
    expect(out.failures.join("\n")).not.toContain("GHSA-old-major-0003");
  });
});

// --- isEntryPoint ----------------------------------------------------------------

describe("isEntryPoint", () => {
  const file = join(NEXT_REPO_ROOT, "scripts", "next-advisory-check.mjs");

  it("is true only when argv[1] is the module's own file", () => {
    expect(isEntryPoint(pathToFileURL(file).href, file)).toBe(true);
    expect(isEntryPoint(pathToFileURL(file).href, join(NEXT_REPO_ROOT, "scripts", "other.mjs"))).toBe(false);
  });

  it("is false when there is no argv[1] (REPL, -e, vitest worker)", () => {
    expect(isEntryPoint(pathToFileURL(file).href, undefined)).toBe(false);
    expect(isEntryPoint(pathToFileURL(file).href, "")).toBe(false);
  });
});

// --- run (stub fetch, temp lockfile) ---------------------------------------------

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "next-advisory-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A package-lock.json with the given next version (or none). */
function writeLock(version) {
  const packages = { "": { name: "x" } };
  if (version !== null) packages["node_modules/next"] = { version };
  const path = join(dir, "package-lock.json");
  writeFileSync(path, JSON.stringify({ lockfileVersion: 3, packages }));
  return path;
}

const json = (body, { status = 200, link } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(link ? { link } : {}) },
  });

/** A fetch stub that answers from a queue (Response, Error or (url, init) => Response). */
function stubFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (next === undefined) throw new Error("stub fetch: queue empty");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}

const sleep = async () => {};
const collect = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)) };
};

const NEXT_LINK = (u) => `<${u}>; rel="next", <https://api.github.com/repositories/1/security-advisories?page=9>; rel="last"`;
const PAGE2 = "https://api.github.com/repositories/70107786/security-advisories?state=published&per_page=100&after=cursor2";

describe("run", () => {
  it("asks for published advisories, 100 per page, with the GitHub API headers and a timeout signal", async () => {
    const lock = writeLock("16.4.5");
    const fetchImpl = stubFetch([json([])]);
    const { log } = collect();
    const code = await run({ fetchImpl, lockPath: lock, env: {}, log, sleep });
    expect(code).toBe(0);
    expect(ADVISORIES_URL).toBe("https://api.github.com/repos/vercel/next.js/security-advisories?state=published&per_page=100");
    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0];
    expect(call.url).toBe(ADVISORIES_URL);
    const headers = new Headers(call.init.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("authorization")).toBeNull();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the token as a Bearer header when GITHUB_TOKEN is set, and never prints it", async () => {
    const lock = writeLock("16.4.5");
    const fetchImpl = stubFetch([json([advisory({ id: MFR8, range: ">= 16.3.0", patched: "" })])]);
    const { lines, log } = collect();
    const code = await run({ fetchImpl, lockPath: lock, env: { GITHUB_TOKEN: "ghs_testtoken123" }, log, sleep });
    expect(new Headers(fetchImpl.calls[0].init.headers).get("authorization")).toBe("Bearer ghs_testtoken123");
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("ghs_testtoken123");
  });

  it("follows Link rel=next across pages and evaluates the advisories of every page", async () => {
    const lock = writeLock("16.4.3");
    const fetchImpl = stubFetch([
      json([advisory({ id: "GHSA-page-one-0001", range: "< 15.5.7", patched: "15.5.7" })], { link: NEXT_LINK(PAGE2) }),
      json([advisory({ id: "GHSA-page-two-0002", range: ">= 16.0.0, < 16.4.5", patched: "16.4.5" })]),
    ]);
    const { lines, log } = collect();
    const code = await run({ fetchImpl, lockPath: lock, env: {}, log, sleep });
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([ADVISORIES_URL, PAGE2]);
    expect(code).toBe(1);
    expect(lines.filter((l) => l.includes("GHSA-page-two-0002"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("GHSA-page-one-0001");
  });

  it("exits 0 and prints one line per in-range advisory when the installed version is fixed or acknowledged", async () => {
    const lock = writeLock("16.4.5");
    const fetchImpl = stubFetch([
      json([
        advisory({ id: MFR8, range: ">= 16.3.0", patched: "" }),
        advisory({ id: "GHSA-aaaa-bbbb-cccc", range: ">= 16.0.0, < 16.4.5", patched: "16.4.5" }),
        advisory({ id: "GHSA-withdrawn-0001", range: ">= 16.3.0", patched: "", withdrawn: "2026-11-02T00:00:00Z" }),
      ]),
    ]);
    const { lines, log } = collect();
    expect(await run({ fetchImpl, lockPath: lock, env: {}, log, sleep })).toBe(0);
    expect(lines.filter((l) => l.includes(MFR8))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("GHSA-aaaa-bbbb-cccc");
    expect(lines.join("\n")).not.toContain("GHSA-withdrawn-0001");
    expect(lines.join("\n")).toContain("16.4.5");
  });

  it("exits 1 on an unacknowledged advisory that covers the installed version", async () => {
    const lock = writeLock("16.4.5");
    const fetchImpl = stubFetch([json([advisory({ id: "GHSA-fresh-0001-aaaa", range: ">= 16.3.0", patched: "" })])]);
    const { lines, log } = collect();
    expect(await run({ fetchImpl, lockPath: lock, env: {}, log, sleep })).toBe(1);
    expect(lines.some((l) => l.startsWith("FAIL") && l.includes("GHSA-fresh-0001-aaaa"))).toBe(true);
  });

  it("fails closed on HTTP 403 (rate limit / forbidden), after one retry", async () => {
    const lock = writeLock("16.4.5");
    const fetchImpl = stubFetch([json({ message: "rate limited" }, { status: 403 }), json({ message: "rate limited" }, { status: 403 })]);
    const { lines, log } = collect();
    expect(await run({ fetchImpl, lockPath: lock, env: {}, log, sleep })).toBe(1);
    expect(fetchImpl.calls).toHaveLength(2);
    expect(lines.join("\n")).toContain("403");
    expect(lines.join("\n").toLowerCase()).toContain("fail");
  });

  it("recovers from one transient failure (retry) and still reports the advisories", async () => {
    const lock = writeLock("16.4.5");
    const fetchImpl = stubFetch([json({}, { status: 502 }), json([])]);
    const { log } = collect();
    expect(await run({ fetchImpl, lockPath: lock, env: {}, log, sleep })).toBe(0);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("fails closed when the network errors twice", async () => {
    const lock = writeLock("16.4.5");
    const fetchImpl = stubFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const { lines, log } = collect();
    expect(await run({ fetchImpl, lockPath: lock, env: {}, log, sleep })).toBe(1);
    expect(fetchImpl.calls).toHaveLength(2);
    expect(lines.join("\n")).toContain("fetch failed");
  });

  it("fails closed on a body that is not a JSON array", async () => {
    const lock = writeLock("16.4.5");
    const { log } = collect();
    expect(await run({ fetchImpl: stubFetch([json({ advisories: [] })]), lockPath: lock, env: {}, log, sleep })).toBe(1);
    const notJson = () => new Response("<html>oops</html>", { status: 200 });
    expect(await run({ fetchImpl: stubFetch([notJson, notJson]), lockPath: lock, env: {}, log, sleep })).toBe(1);
  });

  it(`reads at most ${MAX_PAGES} pages and fails closed when more remain`, async () => {
    const lock = writeLock("16.4.5");
    let n = 0;
    const endless = () => json([], { link: NEXT_LINK(`https://api.github.com/repositories/70107786/security-advisories?after=p${++n}`) });
    const fetchImpl = stubFetch(Array.from({ length: 20 }, () => endless));
    const { lines, log } = collect();
    expect(await run({ fetchImpl, lockPath: lock, env: {}, log, sleep })).toBe(1);
    expect(MAX_PAGES).toBe(10);
    expect(fetchImpl.calls).toHaveLength(10);
    expect(lines.join("\n")).toContain("10 pages");
  });

  it("refuses a Link rel=next that leaves api.github.com, so the token cannot travel elsewhere", async () => {
    const lock = writeLock("16.4.5");
    const evil = "https://evil.example/security-advisories?after=x";
    const lookalike = "https://api.github.com.evil.example/security-advisories";
    for (const target of [evil, lookalike, "http://api.github.com/repositories/1/security-advisories"]) {
      const fetchImpl = stubFetch([json([], { link: NEXT_LINK(target) }), json([])]);
      const { log } = collect();
      expect(await run({ fetchImpl, lockPath: lock, env: { GITHUB_TOKEN: "ghs_testtoken123" }, log, sleep })).toBe(1);
      expect(fetchImpl.calls.map((c) => c.url)).toEqual([ADVISORIES_URL]);
    }
  });

  it("takes the installed version from the lockfile and fails closed when next is not in it", async () => {
    const { lines, log } = collect();
    const fetchImpl = stubFetch([json([])]);
    expect(await run({ fetchImpl, lockPath: writeLock(null), env: {}, log, sleep })).toBe(1);
    expect(fetchImpl.calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("node_modules/next");
    expect(await run({ fetchImpl, lockPath: join(dir, "missing.json"), env: {}, log, sleep })).toBe(1);
  });

  it("evaluates against the repository's real lockfile by default path argument", async () => {
    const fetchImpl = stubFetch([json([advisory({ id: MFR8, range: ">= 16.3.0", patched: "" })])]);
    const { log } = collect();
    // The real lockfile resolves next at or above 16.4.5 (next-security-floor.test.ts), so the acknowledged
    // advisory passes; this proves the default ACKNOWLEDGED table and a real lockfile line up.
    expect(await run({ fetchImpl, lockPath: join(NEXT_REPO_ROOT, "package-lock.json"), env: {}, log, sleep })).toBe(0);
  });
});
