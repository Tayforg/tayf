import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

import { CLUSTER_FEED_TAGS } from "@/lib/clusters/merge";

// ---------------------------------------------------------------------------
// Permanent CI guard (cache hygiene): an admin mutation that changes cluster
// membership must invalidate EVERY cluster-list cache, not just the two its
// author remembered.
//
// Background: `jev-unlink` revalidated "clusters", "clusters-politics" and
// `cluster-detail:<id>` only, so an unlinked article stayed on search results
// ("clusters-search") and /gundem/<key> hubs ("clusters-entity") for the full
// cache window. The tag list now lives in ONE place, `CLUSTER_FEED_TAGS` in
// src/lib/clusters/merge.ts, behind `clusterMembershipTags()` /
// `mergeRevalidationTags()`.
//
// Three sweeps, all source-text (same technique as rate-limit-429.test.ts,
// whose comment-blanking helper is copied below because a test file cannot be
// imported without registering its tests):
//
//   (a) every cluster-list literal passed to `cacheTag(` anywhere in non-test
//       src/ ("clusters" or "clusters-*") is in CLUSTER_FEED_TAGS, so a new
//       cluster-list cache cannot ship without the admin routes learning
//       about it;
//   (b) no src/app/api/admin/** file hand-writes `revalidateTag("clusters...")`
//       (that is how a tag gets forgotten: go through the helper);
//   (c) every src/app/api/admin/** file that mutates membership
//       (`unlinkClusterArticle(` / `mergeClusters(`) also calls one of the two
//       tag helpers.
//
// Comments are blanked first, so prose that mentions a call does not trip a
// sweep and a comment cannot satisfy one.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Repo-relative path with forward slashes, whatever the platform. */
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

const isTestFile = (p: string) => /\.test\.(ts|tsx)$/.test(p) || /(^|\/)__tests__\//.test(p);

const NON_TEST_SRC_FILES = walk(SRC)
  .map(rel)
  .filter((p) => !isTestFile(p));

const ADMIN_API_FILES = NON_TEST_SRC_FILES.filter((p) =>
  p.startsWith("src/app/api/admin/"),
);

const read = (p: string) => blankComments(readFileSync(resolve(ROOT, p), "utf8"));

// -- matchers ---------------------------------------------------------------

const CACHE_TAG_CALL = /(?<![\w$.])(?:unstable_)?cacheTag\s*\(/g;
const REVALIDATE_TAG_CLUSTERS_LITERAL = /(?<![\w$])revalidateTag\s*\(\s*(["'`])clusters/;
const MEMBERSHIP_MUTATION = /(?<![\w$])(?:unlinkClusterArticle|mergeClusters)\s*\(/;
const TAG_HELPER_CALL = /(?<![\w$])(?:clusterMembershipTags|mergeRevalidationTags)\s*\(/;

/** True for the cluster-LIST tag family: "clusters" and "clusters-<anything>".
 *  "cluster-detail:<id>" (singular) is a per-cluster tag, not a list tag. */
const isClusterListTag = (literal: string) =>
  literal === "clusters" || literal.startsWith("clusters-");

/**
 * Text between the parentheses of the call whose "(" is at `open`, balanced
 * over nested parens and opaque over string / template literals. Returns null
 * when the call is never closed.
 */
function callArguments(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      if (i < 0) return null;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Index of the closing quote of the string literal opening at `start`, or -1. */
function skipString(src: string, start: number): number {
  const quote = src[start]!;
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === "\\") i += 1;
    else if (ch === quote) return i;
  }
  return -1;
}

/** Every string-literal body (quotes stripped) in a chunk of call arguments. */
function stringLiterals(args: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(args, i);
      if (end < 0) break;
      out.push(args.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

/** Every string literal passed to a `cacheTag(` call in already comment-blanked source. */
function cacheTagLiterals(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(CACHE_TAG_CALL)) {
    const args = callArguments(src, m.index! + m[0].length - 1);
    if (args !== null) out.push(...stringLiterals(args));
  }
  return out;
}

// -- (a) ---------------------------------------------------------------------

describe("(a) every cluster-list cacheTag is in CLUSTER_FEED_TAGS", () => {
  const known = new Set<string>(CLUSTER_FEED_TAGS);

  it("flags nothing in non-test src/", () => {
    const offenders: string[] = [];
    for (const p of NON_TEST_SRC_FILES) {
      for (const lit of cacheTagLiterals(read(p))) {
        if (isClusterListTag(lit) && !known.has(lit)) offenders.push(`${p}: "${lit}"`);
      }
    }
    expect(
      offenders,
      "add the tag to CLUSTER_FEED_TAGS (src/lib/clusters/merge.ts) so every membership mutation revalidates it",
    ).toEqual([]);
  });

  it("is not vacuous: every CLUSTER_FEED_TAGS entry is still cached somewhere", () => {
    const seen = new Set<string>();
    for (const p of NON_TEST_SRC_FILES) {
      for (const lit of cacheTagLiterals(read(p))) seen.add(lit);
    }
    const stale = CLUSTER_FEED_TAGS.filter((t) => !seen.has(t));
    expect(stale, "CLUSTER_FEED_TAGS lists a tag no cacheTag() uses any more").toEqual([]);
  });

  it("is not vacuous: finds the known cacheTag owners", () => {
    const entity = cacheTagLiterals(read("src/lib/entities/entity-hub-query.ts"));
    expect(entity).toContain("clusters-entity");
    const search = cacheTagLiterals(read("src/lib/clusters/search-query.ts"));
    expect(search).toContain("clusters-search");
  });
});

// -- (b) ---------------------------------------------------------------------

describe("(b) admin routes never hand-write a clusters* revalidateTag", () => {
  it("is not vacuous: the admin API files were found", () => {
    expect(ADMIN_API_FILES).toContain("src/app/api/admin/jev-unlink/route.ts");
    expect(ADMIN_API_FILES).toContain("src/app/api/admin/cluster-merge/route.ts");
  });

  it("flags nothing under src/app/api/admin/", () => {
    const offenders = ADMIN_API_FILES.filter((p) =>
      REVALIDATE_TAG_CLUSTERS_LITERAL.test(read(p)),
    );
    expect(
      offenders,
      "use clusterMembershipTags() / mergeRevalidationTags() instead of a literal",
    ).toEqual([]);
  });
});

// -- (c) ---------------------------------------------------------------------

describe("(c) membership-changing admin routes use a tag helper", () => {
  const mutators = ADMIN_API_FILES.filter((p) => MEMBERSHIP_MUTATION.test(read(p)));

  it("is not vacuous: jev-unlink and cluster-merge are both found", () => {
    expect(mutators).toContain("src/app/api/admin/jev-unlink/route.ts");
    expect(mutators).toContain("src/app/api/admin/cluster-merge/route.ts");
  });

  it("every such route also calls clusterMembershipTags() or mergeRevalidationTags()", () => {
    const missing = mutators.filter((p) => !TAG_HELPER_CALL.test(read(p)));
    expect(missing).toEqual([]);
  });
});

// -- (d) the sweep's own matchers --------------------------------------------

describe("(d) the sweep's own matchers", () => {
  it("collects every literal of a multi-argument cacheTag call, on one line or several", () => {
    expect(cacheTagLiterals('cacheTag("clusters", "clusters-politics");')).toEqual([
      "clusters",
      "clusters-politics",
    ]);
    expect(cacheTagLiterals("cacheTag(\n  'clusters-search',\n  `cluster-detail:${id}`,\n);")).toEqual([
      "clusters-search",
      "cluster-detail:${id}",
    ]);
    expect(cacheTagLiterals("cacheTag(...CLUSTER_FEED_TAGS)")).toEqual([]);
  });

  it("stops at the closing paren of the call, not at the next statement", () => {
    expect(cacheTagLiterals('cacheTag("sources"); const x = "clusters-new";')).toEqual(["sources"]);
    expect(cacheTagLiterals('cacheTag(pick("clusters-a"), "b"); log("clusters-c")')).toEqual([
      "clusters-a",
      "b",
    ]);
  });

  it("ignores parens and quotes inside string literals", () => {
    expect(cacheTagLiterals('cacheTag("a)b", "clusters-x")')).toEqual(["a)b", "clusters-x"]);
    expect(cacheTagLiterals("cacheTag('it\\'s', \"clusters-y\")")).toEqual(["it\\'s", "clusters-y"]);
  });

  it("recognises unstable_cacheTag but not a longer identifier or a method", () => {
    expect(cacheTagLiterals('unstable_cacheTag("clusters-z")')).toEqual(["clusters-z"]);
    expect(cacheTagLiterals('myCacheTag("clusters-q")')).toEqual([]);
    expect(cacheTagLiterals('xcacheTag("clusters-q")')).toEqual([]);
    expect(cacheTagLiterals('obj.cacheTag("clusters-q")')).toEqual([]);
    expect(cacheTagLiterals('import { cacheTag } from "next/cache";')).toEqual([]);
  });

  it("returns nothing for an unclosed call instead of looping or throwing", () => {
    expect(cacheTagLiterals('cacheTag("clusters-open"')).toEqual([]);
    expect(cacheTagLiterals('cacheTag("unterminated)')).toEqual([]);
  });

  it("ignores prose in comments but not code", () => {
    const src = [
      '// cacheTag("clusters-fake") is documented here',
      '/* cacheTag("clusters-fake2") */',
      'cacheTag("clusters-real");',
    ].join("\n");
    expect(cacheTagLiterals(blankComments(src))).toEqual(["clusters-real"]);
  });

  it("classifies the cluster-list tag family", () => {
    expect(isClusterListTag("clusters")).toBe(true);
    expect(isClusterListTag("clusters-politics")).toBe(true);
    expect(isClusterListTag("clusters-future-list")).toBe(true);
    expect(isClusterListTag("clusters-${kind}")).toBe(true);
    expect(isClusterListTag("cluster-detail:abc")).toBe(false);
    expect(isClusterListTag("cluster-detail:${id}")).toBe(false);
    expect(isClusterListTag("clustersx")).toBe(false);
    expect(isClusterListTag("sources")).toBe(false);
  });

  it("(b) matches a literal clusters* revalidateTag in any quote style, not a helper loop", () => {
    expect(REVALIDATE_TAG_CLUSTERS_LITERAL.test('revalidateTag("clusters", "max");')).toBe(true);
    expect(REVALIDATE_TAG_CLUSTERS_LITERAL.test("revalidateTag('clusters-search', 'max')")).toBe(true);
    expect(REVALIDATE_TAG_CLUSTERS_LITERAL.test("revalidateTag(\n  `clusters-entity`, 'max')")).toBe(true);
    expect(REVALIDATE_TAG_CLUSTERS_LITERAL.test('revalidateTag(tag, "max");')).toBe(false);
    expect(REVALIDATE_TAG_CLUSTERS_LITERAL.test('revalidateTag("cluster-detail:1", "max")')).toBe(false);
    expect(REVALIDATE_TAG_CLUSTERS_LITERAL.test('revalidateTag("sources", "max")')).toBe(false);
    expect(REVALIDATE_TAG_CLUSTERS_LITERAL.test('import { revalidateTag } from "next/cache";')).toBe(false);
    const blanked = blankComments('// revalidateTag("clusters", "max")\nrevalidateTag(tag, "max");');
    expect(REVALIDATE_TAG_CLUSTERS_LITERAL.test(blanked)).toBe(false);
  });

  it("(c) matches calls, not import specifiers or longer identifiers", () => {
    expect(MEMBERSHIP_MUTATION.test("const r = await unlinkClusterArticle(id);")).toBe(true);
    expect(MEMBERSHIP_MUTATION.test("await mergeClusters({ source })")).toBe(true);
    expect(MEMBERSHIP_MUTATION.test("import { keepClusterArticle, unlinkClusterArticle } from 'x';")).toBe(false);
    expect(MEMBERSHIP_MUTATION.test("keepClusterArticle(id)")).toBe(false);
    expect(MEMBERSHIP_MUTATION.test("await dryRunMergeClusters(x)")).toBe(false);
    expect(TAG_HELPER_CALL.test("for (const t of clusterMembershipTags(id)) {}")).toBe(true);
    expect(TAG_HELPER_CALL.test("mergeRevalidationTags(source, target)")).toBe(true);
    expect(TAG_HELPER_CALL.test("import { mergeRevalidationTags } from 'x';")).toBe(false);
    expect(TAG_HELPER_CALL.test(blankComments("// clusterMembershipTags(id)\nreturn;"))).toBe(false);
  });
});
