import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Permanent CI guard: the "Olası ikiz kümeler" review list on /admin/birlestir
// (migration 120) can only ever SHOW twin cluster pairs. It must not merge
// anything on its own, and it must not be reachable without an admin session.
//
//   (1) the page's default export starts with `await requireAdminSession()`
//       and carries no "use cache";
//   (2) src/lib/admin/twin-clusters.ts has no write call (.insert / .update /
//       .delete / .upsert) and calls no rpc but admin_twin_cluster_pairs, in
//       particular never cluster_merge_atomic or the mergeClusters helper:
//       a merge stays one admin click on the existing flow;
//   (3) migration 120 grants EXECUTE to service_role only;
//   (4) non-vacuity: every finder below is run against synthetic bad source.
//
// Source is scanned with comments blanked (same helper as anon-surface.test.ts,
// copied because a test file cannot be imported without registering its tests),
// so prose in a comment can neither trip nor satisfy a check.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE = resolve(ROOT, "src/app/admin/(protected)/birlestir/page.tsx");
const READER = resolve(ROOT, "src/lib/admin/twin-clusters.ts");
const MIGRATION = resolve(ROOT, "supabase/migrations/120_twin_cluster_pairs.sql");

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Text of the first statement in the body of `export default async function`. */
function firstStatementOfDefaultExport(code: string): string | null {
  const m = code.match(/export\s+default\s+async\s+function\s+\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/);
  if (!m || m.index === undefined) return null;
  const rest = code.slice(m.index + m[0].length).trimStart();
  const end = rest.indexOf(";");
  return end === -1 ? rest : rest.slice(0, end + 1).replace(/\s+/g, " ");
}

/** Write calls on a Supabase builder. */
function writeCalls(code: string): string[] {
  return [...code.matchAll(/\.\s*(insert|update|delete|upsert)\s*\(/g)].map((m) => m[1] as string);
}

/** Names passed to `.rpc(` (string literal first argument), or "<dynamic>". */
function rpcNames(code: string): string[] {
  return [...code.matchAll(/\.\s*rpc\s*\(\s*(?:(["'`])([^"'`]*)\1)?/g)].map((m) => m[2] ?? "<dynamic>");
}

/** Every grant statement of a migration, flattened to one line. */
function grants(sqlCode: string): string[] {
  return (sqlCode.replace(/\s+/g, " ").match(/\bgrant\b[^;]*;/gi) ?? []).map((g) => g.trim());
}

describe("admin twin review: the page", () => {
  const code = blankComments(readFileSync(PAGE, "utf8"));

  it("starts the default export with `await requireAdminSession()`", () => {
    expect(firstStatementOfDefaultExport(code)).toBe("await requireAdminSession();");
    expect(code).toMatch(/import\s*\{[^}]*\brequireAdminSession\b[^}]*\}\s*from\s*"@\/lib\/admin\/session"/);
  });

  it("is dynamic and cookie-gated: no 'use cache' directive", () => {
    expect(code).not.toMatch(/["']use cache["']/);
  });

  it("renders twin rows with origin manual and keeps İkiz haber out of the log label map", () => {
    expect(code).toMatch(/getTwinClusterPairs/);
    expect(code).toMatch(/origin="manual"/);
    const logMap = code.match(/const\s+LOG_ORIGIN_LABEL[^=]*=\s*\{[\s\S]*?\};/)?.[0] ?? "";
    expect(logMap).toContain("manual");
    expect(logMap).not.toMatch(/İkiz/);
  });

  it("does not talk to the database or the merge flow itself", () => {
    expect(writeCalls(code)).toEqual([]);
    expect(rpcNames(code)).toEqual([]);
    expect(code).not.toMatch(/cluster_merge_atomic|mergeClusters|\bfetch\s*\(/);
  });
});

describe("admin twin review: the reader never merges", () => {
  it("exists", () => {
    expect(existsSync(READER), "src/lib/admin/twin-clusters.ts must exist").toBe(true);
  });

  const code = existsSync(READER) ? blankComments(readFileSync(READER, "utf8")) : "";

  it("has no write call (.insert / .update / .delete / .upsert)", () => {
    expect(writeCalls(code)).toEqual([]);
  });

  it("calls exactly one rpc, admin_twin_cluster_pairs", () => {
    expect(rpcNames(code)).toEqual(["admin_twin_cluster_pairs"]);
  });

  it("never names the merge function or imports the merge helper or the HTTP flow", () => {
    expect(code).not.toMatch(/cluster_merge_atomic/);
    expect(code).not.toMatch(/mergeClusters|clusters\/merge/);
    expect(code).not.toMatch(/api\/admin\/cluster-merge/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("admin twin review: migration 120", () => {
  it("exists", () => {
    expect(existsSync(MIGRATION), "120_twin_cluster_pairs.sql must exist").toBe(true);
  });

  const sql = existsSync(MIGRATION) ? stripSqlComments(readFileSync(MIGRATION, "utf8")) : "";

  it("grants execute to service_role only, and nothing else to anyone", () => {
    const g = grants(sql);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatch(
      /^grant execute on function public\.admin_twin_cluster_pairs\(integer, integer\) to service_role;$/i,
    );
  });
});

describe("admin twin review: the finders are not vacuous", () => {
  it("flags the first statement when it is not the admin gate", () => {
    const bad = "export default async function P() {\n  const rows = await load();\n  await requireAdminSession();\n}";
    expect(firstStatementOfDefaultExport(bad)).toBe("const rows = await load();");
    expect(firstStatementOfDefaultExport("export default function P() {}")).toBeNull();
    const ok = "export default async function P(): Promise<JSX.Element> {\n  await requireAdminSession();\n  return null;\n}";
    expect(firstStatementOfDefaultExport(ok)).toBe("await requireAdminSession();");
  });

  it("flags write calls and foreign rpcs", () => {
    expect(writeCalls('supabase.from("clusters").update({ a: 1 }).eq("id", x)')).toEqual(["update"]);
    expect(writeCalls('s.from("t").insert(r); s.from("t").upsert(r); s.from("t").delete()')).toEqual([
      "insert",
      "upsert",
      "delete",
    ]);
    expect(rpcNames('s.rpc("admin_twin_cluster_pairs", {}); s.rpc("cluster_merge_atomic", {})')).toEqual([
      "admin_twin_cluster_pairs",
      "cluster_merge_atomic",
    ]);
    expect(rpcNames("s.rpc(name, {})")).toEqual(["<dynamic>"]);
  });

  it("blankComments hides prose but not code", () => {
    const src = '// s.rpc("cluster_merge_atomic")\n/* .update( */ s.rpc("admin_twin_cluster_pairs", {})';
    const cleaned = blankComments(src);
    expect(rpcNames(cleaned)).toEqual(["admin_twin_cluster_pairs"]);
    expect(writeCalls(cleaned)).toEqual([]);
  });

  it("finds every grant, including a second grant to anon", () => {
    const bad =
      "grant execute on function public.f(integer) to service_role;\ngrant execute on function public.f(integer) to anon;";
    expect(grants(bad)).toHaveLength(2);
    expect(grants("revoke all on function public.f(integer) from anon;")).toEqual([]);
  });
});
