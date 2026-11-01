import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (cache hygiene, hunt 8 finding h8-admin-1): every source
// mutation in the admin route must revalidate its caches, and the source row
// itself must never be deleted by a bare table delete.
//
// Background: toggle_source, add_source, update_source and set_source_rights
// returned success without revalidating the "sources"-tagged caches (the
// /source/[slug] profile, the /api/sources registry), and set_source_rights
// also left the cluster-detail and feed caches that read the rights flags
// stale. delete_source was a bare `.from("sources").delete()`: the cascade
// removed the source's articles from their clusters and nothing recomputed
// those clusters or revalidated anything. It is now the delete_source RPC
// (migration 128), which recomputes the affected clusters and returns their ids.
//
// Source-text sweep (same technique as cluster-membership-tags.test.ts, whose
// comment-blanking helper is copied below because a test file cannot be
// imported without registering its tests):
//
//   (a) src/app/api/admin/route.ts is split into the `case "x":` blocks of its
//       action switch; every case whose label contains "source" calls
//       revalidateTag( -- a comment cannot satisfy this, comments are blanked;
//   (b) the route has no `.from("sources")` chain that reaches `.delete(`.
//
// A new source action that mutates and forgets to revalidate fails (a); a
// regression to the bare delete fails (b). The cluster tags are revalidated
// through CLUSTER_FEED_TAGS / clusterMembershipTags() in the route, never as
// literals (cluster-membership-tags.test.ts guard (b)).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const ROUTE = "src/app/api/admin/route.ts";

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
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

interface CaseBlock {
  label: string;
  body: string;
}

const CASE_LABEL = /case\s+(["'])([^"'\n]*)\1\s*:/y;

/**
 * The top-level `case "x":` blocks of the first `switch (action)` in already
 * comment-blanked source. Only cases directly inside that switch count: the
 * nested `switch (error.code) { case "23514": ... }` of set_source_bias must
 * not split its parent block. A block runs from its label to the next
 * top-level label (or `default:`) or the end of the switch.
 */
function actionCases(src: string, switchHead = /switch\s*\(\s*action\s*\)\s*\{/): CaseBlock[] {
  const head = switchHead.exec(src);
  if (!head) return [];
  const open = head.index + head[0].length - 1;
  const starts: { label: string; at: number; bodyAt: number }[] = [];
  let end = src.length;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = skipString(src, i);
      if (close < 0) break;
      i = close;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    } else if (depth === 1 && ch === "c" && !/[\w$]/.test(src[i - 1] ?? " ")) {
      CASE_LABEL.lastIndex = i;
      const m = CASE_LABEL.exec(src);
      if (m) {
        starts.push({ label: m[2]!, at: i, bodyAt: i + m[0].length });
        i += m[0].length - 1;
      }
    } else if (depth === 1 && ch === "d" && /^default\s*:/.test(src.slice(i)) && !/[\w$]/.test(src[i - 1] ?? " ")) {
      starts.push({ label: "default", at: i, bodyAt: i + "default:".length });
    }
  }
  return starts.map((s, k) => ({
    label: s.label,
    body: src.slice(s.bodyAt, k + 1 < starts.length ? starts[k + 1]!.at : end),
  }));
}

const REVALIDATE_CALL = /(?<![\w$.])revalidateTag\s*\(/;
const FROM_SOURCES = /\.from\(\s*(["'`])sources\1\s*\)/g;

/**
 * Every `.from("sources")` chain in already comment-blanked source: the text
 * from the call to the end of the statement (the next `;` outside a string).
 */
function sourcesChains(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(FROM_SOURCES)) {
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < src.length; i += 1) {
      const ch = src[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        const close = skipString(src, i);
        if (close < 0) break;
        i = close;
      } else if (ch === ";") break;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

const route = blankComments(readFileSync(resolve(ROOT, ROUTE), "utf8"));
const cases = actionCases(route);
const sourceCases = cases.filter((c) => c.label.includes("source"));

describe("(a) every source action in the admin route revalidates", () => {
  it("is not vacuous: the action switch was split and the known source actions are found", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(sourceCases.length).toBeGreaterThanOrEqual(7);
    expect(sourceCases.map((c) => c.label)).toEqual(
      expect.arrayContaining([
        "toggle_source",
        "add_source",
        "update_source",
        "set_source_rights",
        "set_source_registry",
        "set_source_bias",
        "delete_source",
      ]),
    );
    // the nested switch (error.code) of set_source_bias did not leak its labels as cases
    expect(cases.map((c) => c.label)).not.toContain("23514");
    expect(cases.map((c) => c.label)).toContain("default");
  });

  it("every case whose label contains 'source' calls revalidateTag(", () => {
    const missing = sourceCases.filter((c) => !REVALIDATE_CALL.test(c.body)).map((c) => c.label);
    expect(missing, "a source mutation must revalidate its caches").toEqual([]);
  });

  it("delete_source revalidates through the membership helper, not a clusters literal", () => {
    const del = sourceCases.find((c) => c.label === "delete_source");
    expect(del).toBeDefined();
    expect(del!.body).toMatch(/(?<![\w$])clusterMembershipTags\s*\(/);
    expect(del!.body).toMatch(/\.rpc\(\s*["']delete_source["']/);
  });

  it("set_source_rights revalidates the cluster feeds too, through CLUSTER_FEED_TAGS", () => {
    const rights = sourceCases.find((c) => c.label === "set_source_rights");
    expect(rights).toBeDefined();
    expect(rights!.body).toMatch(/of\s+CLUSTER_FEED_TAGS\b/);
  });
});

describe("(b) the source row is never deleted by a table delete", () => {
  it("is not vacuous: the route still has .from(\"sources\") chains", () => {
    expect(sourcesChains(route).length).toBeGreaterThanOrEqual(6);
  });

  it("no .from(\"sources\") chain reaches .delete(", () => {
    const offenders = sourcesChains(route).filter((c) => /\.delete\s*\(/.test(c));
    expect(offenders, "go through the delete_source RPC (migration 128)").toEqual([]);
  });

  it("the sources table is still reachable for update, insert and select in the route", () => {
    const chains = sourcesChains(route).join("\n");
    expect(chains).toMatch(/\.update\(/);
    expect(chains).toMatch(/\.insert\(/);
    expect(chains).toMatch(/\.select\(/);
  });
});

describe("(c) the sweep's own matchers", () => {
  const sample = blankComments(`
    export const POST = async () => {
      switch (action) {
        case "alpha_source": {
          revalidateTag("sources", "max");
          return ok();
        }
        case "beta_source": {
          const x = 1;
          return ok();
        }
        case "gamma": {
          switch (error.code) {
            case "23514":
              return bad();
            case "P0002":
              return missing();
          }
          // revalidateTag("sources", "max") in a comment does not count
          return ok();
        }
        case "delta_source":
          revalidateTag(\`sources\`, "max");
          return ok();
        default:
          return bad("Unknown action");
      }
    };
  `);

  it("splits only the top-level cases and ignores a nested switch", () => {
    expect(actionCases(sample).map((c) => c.label)).toEqual([
      "alpha_source",
      "beta_source",
      "gamma",
      "delta_source",
      "default",
    ]);
  });

  it("keeps a nested switch inside its parent block", () => {
    const gamma = actionCases(sample).find((c) => c.label === "gamma")!;
    expect(gamma.body).toContain('case "23514"');
    expect(gamma.body).toContain("missing()");
    expect(gamma.body).not.toContain("delta_source");
  });

  it("finds a revalidateTag call in the right blocks only, ignoring comments", () => {
    const by = Object.fromEntries(actionCases(sample).map((c) => [c.label, REVALIDATE_CALL.test(c.body)]));
    expect(by).toEqual({
      alpha_source: true,
      beta_source: false,
      gamma: false,
      delta_source: true,
      default: false,
    });
  });

  it("returns nothing when there is no action switch", () => {
    expect(actionCases("const x = 1;")).toEqual([]);
  });

  it("does not match a method or a longer identifier as revalidateTag(", () => {
    expect(REVALIDATE_CALL.test('revalidateTag("sources", "max")')).toBe(true);
    expect(REVALIDATE_CALL.test('  revalidateTag ("sources", "max")')).toBe(true);
    expect(REVALIDATE_CALL.test('cache.revalidateTag("sources")')).toBe(false);
    expect(REVALIDATE_CALL.test('myrevalidateTag("sources")')).toBe(false);
    expect(REVALIDATE_CALL.test('import { revalidateTag } from "next/cache";')).toBe(false);
  });

  it("extracts the whole .from(\"sources\") chain up to the statement end, across lines and quote styles", () => {
    const src = [
      'const a = await supabase.from("sources").delete().eq("id", id);',
      "const b = await supabase\n  .from('sources')\n  .update({ x: 1 })\n  .eq(\"slug\", \"a;b\");",
      'const c = await supabase.from("articles").delete().eq("id", id);',
    ].join("\n");
    const chains = sourcesChains(src);
    expect(chains).toHaveLength(2);
    expect(chains[0]).toMatch(/\.delete\(/);
    expect(chains[1]).toMatch(/\.update\(/);
    expect(chains[1]).not.toMatch(/\.delete\(/);
    // a delete on another table is not an offender
    expect(chains.some((c) => c.includes("articles"))).toBe(false);
  });

  it("flags the bare delete the route used to have", () => {
    const old = blankComments('const { error } = await supabase.from("sources").delete().eq("id", id);');
    expect(sourcesChains(old).filter((c) => /\.delete\s*\(/.test(c))).toHaveLength(1);
  });
});
