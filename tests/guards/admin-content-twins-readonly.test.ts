import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Permanent CI guard: the content-twin detector (migration 139, "Olası içerik
// ikizleri" on /admin/birlestir) can only ever SHOW pairs. It never merges and
// never writes; merging stays one admin click on the existing Birleştir flow.
//
//   (1) src/lib/admin/content-twins.ts has no write call (.insert / .update /
//       .delete / .upsert), calls no rpc but admin_content_twin_pairs, and never
//       names the merge function, the merge helper, the merge HTTP endpoint or
//       fetch(;
//   (2) scripts/lib/content-twin-rescore.mjs and scripts/content-twin-dryrun.mjs
//       have no write call and no merge reference (the script's only rpc is the
//       same read-only function, and it never prints the environment);
//   (3) the page gives every content row <ClusterMergeActions origin="manual">:
//       the merge API and cluster_merge_log accept only manual / thread / recall,
//       and "content" is a display label only;
//   (4) migration 139 revokes anon / authenticated / public and grants EXECUTE to
//       service_role only;
//   (5) non-vacuity: every finder is run against mutated copies of the REAL
//       sources, and against synthetic bad ones.
//
// Source is scanned with comments blanked (same helper as admin-twin-review.test.ts,
// copied because a test file cannot be imported without registering its tests), so
// prose in a comment can neither trip nor satisfy a check.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE = resolve(ROOT, "src/app/admin/(protected)/birlestir/page.tsx");
const READER = resolve(ROOT, "src/lib/admin/content-twins.ts");
const RESCORE = resolve(ROOT, "scripts/lib/content-twin-rescore.mjs");
const DRYRUN = resolve(ROOT, "scripts/content-twin-dryrun.mjs");
const MIGRATION = resolve(ROOT, "supabase/migrations/139_content_twin_candidates.sql");

const FN = "public.admin_content_twin_pairs(integer, integer)";

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Write calls on a Supabase builder. */
function writeCalls(code: string): string[] {
  return [...code.matchAll(/\.\s*(insert|update|delete|upsert)\s*\(/g)].map((m) => m[1] as string);
}

/** Names passed to `.rpc(` (string literal first argument), or "<dynamic>". */
function rpcNames(code: string): string[] {
  return [...code.matchAll(/\.\s*rpc\s*\(\s*(?:(["'`])([^"'`]*)\1)?/g)].map((m) => m[2] ?? "<dynamic>");
}

/** The merge function, the merge helper and the merge endpoint, by any spelling used in the repo. */
function mergeReferences(code: string): string[] {
  return [...code.matchAll(/cluster_merge_atomic|mergeClusters|clusters\/merge|api\/admin\/cluster-merge/g)].map(
    (m) => m[0],
  );
}

function fetchCalls(code: string): string[] {
  return [...code.matchAll(/\bfetch\s*\(/g)].map((m) => m[0]);
}

/** A console call that mentions the service-role key or dumps process.env. */
function envLeaks(code: string): string[] {
  return [
    ...code.matchAll(/console\.\w+\s*\([^;]*(?:SERVICE_ROLE|process\.env\s*[,)]|JSON\.stringify\s*\(\s*process\.env)/g),
  ].map((m) => m[0]);
}

/** The JSX of the content-twin AdminSection, from its id to its closing tag. */
function contentSection(code: string): string | null {
  const start = code.search(/id=["']icerik-ikizleri["']/);
  if (start === -1) return null;
  const end = code.indexOf("</AdminSection>", start);
  return end === -1 ? null : code.slice(start, end);
}

/** Every `origin=` JSX attribute in a chunk: its string literal, or "{expr}". */
function originProps(chunk: string): string[] {
  return [...chunk.matchAll(/\borigin=(?:"([^"]*)"|\{([^}]*)\})/g)].map((m) => m[1] ?? `{${m[2]}}`);
}

/** Every grant statement of a migration, flattened to one line. */
function grants(sqlCode: string): string[] {
  return (sqlCode.replace(/\s+/g, " ").match(/\bgrant\b[^;]*;/gi) ?? []).map((g) => g.trim());
}

function revokes(sqlCode: string): string[] {
  return (sqlCode.replace(/\s+/g, " ").match(/\brevoke\b[^;]*;/gi) ?? []).map((g) => g.trim());
}

const read = (p: string) => readFileSync(p, "utf8");

// -- (1) the reader --------------------------------------------------------------

describe("admin content twins: the reader never merges", () => {
  it("exists", () => {
    expect(existsSync(READER), "src/lib/admin/content-twins.ts must exist").toBe(true);
  });

  const code = existsSync(READER) ? blankComments(read(READER)) : "";

  it("has no write call (.insert / .update / .delete / .upsert)", () => {
    expect(writeCalls(code)).toEqual([]);
  });

  it("calls exactly one rpc, admin_content_twin_pairs", () => {
    expect(rpcNames(code)).toEqual(["admin_content_twin_pairs"]);
  });

  it("never names the merge function, the merge helper or the merge endpoint, and never calls fetch(", () => {
    expect(mergeReferences(code)).toEqual([]);
    expect(fetchCalls(code)).toEqual([]);
  });

  it("leaves the keyed-twin reader pinned to its own rpc (twin-clusters.ts is untouched by design)", () => {
    const twin = blankComments(read(resolve(ROOT, "src/lib/admin/twin-clusters.ts")));
    expect(rpcNames(twin)).toEqual(["admin_twin_cluster_pairs"]);
  });
});

// -- (2) the re-scorer and the dry-run script ------------------------------------------

describe("admin content twins: the re-scorer and the dry-run script never write or merge", () => {
  for (const [name, path] of [
    ["scripts/lib/content-twin-rescore.mjs", RESCORE],
    ["scripts/content-twin-dryrun.mjs", DRYRUN],
  ] as const) {
    describe(name, () => {
      it("exists", () => {
        expect(existsSync(path), `${name} must exist`).toBe(true);
      });
      const src = existsSync(path) ? blankComments(read(path)) : "";

      it("has no write call", () => {
        expect(writeCalls(src)).toEqual([]);
      });

      it("has no merge reference", () => {
        expect(mergeReferences(src)).toEqual([]);
      });

      it("calls no rpc except admin_content_twin_pairs", () => {
        for (const n of rpcNames(src)) expect(n).toBe("admin_content_twin_pairs");
      });

      it("never prints the environment or the service-role key", () => {
        expect(envLeaks(src)).toEqual([]);
      });
    });
  }

  it("the re-scorer is pure: no network, no client, no fs, no clock", () => {
    const src = blankComments(read(RESCORE));
    expect(src).not.toMatch(/supabase|createClient|\bfetch\s*\(|node:fs|node:http|Date\.now|new Date\(\)|Math\.random/);
  });
});

// -- (3) the page --------------------------------------------------------------------------

describe("admin content twins: the page", () => {
  const code = blankComments(read(PAGE));
  const section = contentSection(code);

  it("has the Olası içerik ikizleri section, right after the merge queue", () => {
    expect(section, 'AdminSection id="icerik-ikizleri" must exist').not.toBeNull();
    const ids = [...code.matchAll(/<AdminSection[^>]*?\bid=["']([^"']+)["']/g)].map((m) => m[1]);
    expect(ids.slice(0, 3)).toEqual(["birlestirme-adaylari", "icerik-ikizleri", "olasi-ikiz-kumeler"]);
  });

  it("passes origin=\"manual\" (and only that) to ClusterMergeActions for content rows", () => {
    expect(originProps(section ?? "")).toEqual(["manual"]);
    expect(section ?? "").toMatch(/<ClusterMergeActions[\s\S]*?origin="manual"/);
  });

  it("never sends the display origin 'content' to the merge flow", () => {
    expect(code).not.toMatch(/origin=\{?\s*["']?content/);
    expect(code).not.toMatch(/origin\s*:\s*["']content["']/);
  });

  it("reads through getContentTwinPairs only: no rpc, no write, no merge reference, no fetch", () => {
    expect(code).toMatch(/getContentTwinPairs/);
    expect(rpcNames(code)).toEqual([]);
    expect(writeCalls(code)).toEqual([]);
    expect(mergeReferences(code)).toEqual([]);
    expect(fetchCalls(code)).toEqual([]);
  });

  it("does not add the content label to LOG_ORIGIN_LABEL (the log only knows manual / thread / recall)", () => {
    const logMap = code.match(/const\s+LOG_ORIGIN_LABEL[^=]*=\s*\{[\s\S]*?\};/)?.[0] ?? "";
    expect(logMap).toContain("manual");
    expect(logMap).not.toMatch(/content|içerik/i);
  });
});

// -- (4) migration 139 --------------------------------------------------------------------------

describe("admin content twins: migration 139", () => {
  it("exists", () => {
    expect(existsSync(MIGRATION), "139_content_twin_candidates.sql must exist").toBe(true);
  });

  const sql = existsSync(MIGRATION) ? stripSqlComments(read(MIGRATION)) : "";

  it("grants execute to service_role only, and nothing else to anyone", () => {
    const g = grants(sql);
    expect(g).toHaveLength(1);
    expect(g[0]).toBe(`grant execute on function ${FN} to service_role;`);
  });

  it("revokes anon, authenticated and public", () => {
    const r = revokes(sql);
    expect(r).toHaveLength(1);
    expect(r[0]).toBe(`revoke all on function ${FN} from public, anon, authenticated;`);
  });
});

// -- (5) the finders are not vacuous ---------------------------------------------------------------

describe("admin content twins: the finders are not vacuous", () => {
  const reader = blankComments(read(READER));
  const page = blankComments(read(PAGE));
  const sql = stripSqlComments(read(MIGRATION));

  it("flags a write call, a foreign rpc, a merge reference and fetch( injected into the REAL reader", () => {
    expect(writeCalls(`${reader}\nsupabase.from("clusters").update({ a: 1 }).eq("id", x);`)).toEqual(["update"]);
    expect(writeCalls(`${reader}\ns.from("t").insert(r); s.from("t").upsert(r); s.from("t").delete();`)).toEqual([
      "insert",
      "upsert",
      "delete",
    ]);
    expect(rpcNames(`${reader}\nawait supabase.rpc("cluster_merge_atomic", {});`)).toEqual([
      "admin_content_twin_pairs",
      "cluster_merge_atomic",
    ]);
    expect(rpcNames(`${reader}\nawait supabase.rpc(name, {});`)).toEqual(["admin_content_twin_pairs", "<dynamic>"]);
    expect(mergeReferences(`${reader}\nconst r = await mergeClusters({});`)).toEqual(["mergeClusters"]);
    expect(mergeReferences(`${reader}\nconst u = "/api/admin/cluster-merge";`)).toEqual(["api/admin/cluster-merge"]);
    expect(fetchCalls(`${reader}\nawait fetch("/x");`)).toEqual(["fetch("]);
  });

  it("blankComments hides prose but not code", () => {
    const src = '// s.rpc("cluster_merge_atomic")\n/* .update( */ s.rpc("admin_content_twin_pairs", {})';
    const cleaned = blankComments(src);
    expect(rpcNames(cleaned)).toEqual(["admin_content_twin_pairs"]);
    expect(writeCalls(cleaned)).toEqual([]);
    expect(mergeReferences(cleaned)).toEqual([]);
  });

  it("flags the display origin when the REAL page section is mutated", () => {
    const section = contentSection(page) as string;
    expect(originProps(section)).toEqual(["manual"]);
    expect(originProps(section.replace('origin="manual"', 'origin="content"'))).toEqual(["content"]);
    expect(originProps(section.replace('origin="manual"', "origin={row.origin}"))).toEqual(["{row.origin}"]);
    expect(originProps(section.replace('origin="manual"', ""))).toEqual([]);
    expect(contentSection(page.replace('id="icerik-ikizleri"', 'id="other"'))).toBeNull();
  });

  it("flags an extra or widened grant in the REAL migration", () => {
    expect(grants(sql)).toHaveLength(1);
    expect(grants(`${sql}\ngrant execute on function ${FN} to anon;`)).toHaveLength(2);
    expect(grants(`${sql}\ngrant select on table public.clusters to authenticated;`)).toHaveLength(2);
    expect(grants(sql.replace("to service_role;", "to service_role, anon;"))[0]).not.toBe(
      `grant execute on function ${FN} to service_role;`,
    );
    expect(revokes(sql.replace("from public, anon, authenticated;", "from public;"))[0]).not.toBe(
      `revoke all on function ${FN} from public, anon, authenticated;`,
    );
  });

  it("finds a leaked key or a dumped environment in a console call", () => {
    expect(envLeaks('console.log(process.env.SUPABASE_SERVICE_ROLE_KEY);')).toHaveLength(1);
    expect(envLeaks("console.error(`key ${SERVICE_ROLE}`);")).toHaveLength(1);
    expect(envLeaks("console.log(JSON.stringify(process.env));")).toHaveLength(1);
    expect(envLeaks("const key = process.env.SUPABASE_SERVICE_ROLE_KEY; console.log('ok');")).toEqual([]);
  });

  it("every source file the guard reads is non-empty (the scan sees something)", () => {
    for (const src of [reader, page, sql, blankComments(read(RESCORE)), blankComments(read(DRYRUN))]) {
      expect(src.length).toBeGreaterThan(200);
    }
  });
});
