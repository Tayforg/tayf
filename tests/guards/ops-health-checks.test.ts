import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Permanent CI guard (ops heartbeat): public.ops_health_report() is re-created,
// whole, by every migration that changes one check (077, 100, 103, 108, 114).
// Each re-creation is a copy-paste of the previous body, so the easy mistake is
// a check that silently drops out of the copy: the report still returns rows,
// the heartbeat still runs, and nobody learns that, say, jev_shadow_cron_
// failures_30m stopped being evaluated. This sweep reads every migration that
// re-creates the function, in number order, and fails when a version loses a
// literal `check_name` of the version before it. The newest version must also
// carry the newest check (sources_newly_dark, 114) and grant execute to
// service_role only.
//
// Only literal names are compared (`check_name := 'name';`). The three
// per-zone freshness rows are built in a loop (`'ingest_fresh_' || v_zone ||
// '_min'`); their presence is pinned separately below.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, "..", "..", "supabase", "migrations");

const NEWEST_CHECK = "sources_newly_dark";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

type Version = {
  file: string;
  num: number;
  code: string;
  body: string;
  names: string[];
};

/** The SQL body between the dollar quotes of the ops_health_report() definition, or null. */
function functionBody(code: string): string | null {
  const m = /create\s+or\s+replace\s+function\s+public\.ops_health_report\s*\([\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\1/i.exec(
    code,
  );
  return m ? (m[2] as string) : null;
}

function literalCheckNames(body: string): string[] {
  return [...body.matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1] as string);
}

let versions: Version[] = [];

beforeAll(() => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  versions = [];
  for (const file of files) {
    const code = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    const body = functionBody(code);
    if (body === null) continue;
    versions.push({ file, num: parseInt(file, 10), code, body, names: literalCheckNames(body) });
  }
});

describe("ops_health_report(): versions across migrations", () => {
  it("finds every re-creation (077, 100, 103, 108, 114) in number order", () => {
    expect(versions.length).toBeGreaterThanOrEqual(5);
    expect(versions[0]?.num).toBe(77);
    expect(versions.map((v) => v.num)).toEqual(expect.arrayContaining([77, 100, 103, 108, 114]));
    const nums = versions.map((v) => v.num);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });

  it("every version evaluates a plausible number of literal checks (the parser is not vacuous)", () => {
    for (const v of versions) {
      expect(v.names.length, `${v.file}: literal check names`).toBeGreaterThanOrEqual(7);
    }
  });

  it("no version lists a literal check name twice", () => {
    for (const v of versions) {
      expect(new Set(v.names).size, `${v.file}: duplicate check_name`).toBe(v.names.length);
    }
  });

  it("every version keeps the three per-zone freshness rows (the check_name built in the loop)", () => {
    for (const v of versions) {
      expect(v.body, v.file).toMatch(/check_name\s*:=\s*'ingest_fresh_'\s*\|\|\s*v_zone\s*\|\|\s*'_min'/i);
      expect(v.body, v.file).toMatch(/foreach\s+v_zone\s+in\s+array\s+array\s*\[\s*'iktidar'\s*,\s*'bagimsiz'\s*,\s*'muhalefet'\s*\]/i);
    }
  });

  it("each version keeps every literal check_name of the version before it", () => {
    expect(versions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < versions.length; i++) {
      const prev = versions[i - 1] as Version;
      const cur = versions[i] as Version;
      const missing = prev.names.filter((n) => !cur.names.includes(n));
      expect(missing, `${cur.file} dropped checks that ${prev.file} had`).toEqual([]);
    }
  });
});

describe("ops_health_report(): the newest version", () => {
  let newest: Version;
  beforeAll(() => {
    newest = versions[versions.length - 1] as Version;
  });

  it(`contains ${NEWEST_CHECK}`, () => {
    expect(newest.names).toContain(NEWEST_CHECK);
  });

  it("revokes from public, anon and authenticated, and grants execute only to service_role", () => {
    expect(newest.code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_health_report\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    const grants = [...newest.code.matchAll(/\bgrant\b[^;]*\bon\s+function\s+public\.ops_health_report\s*\([^)]*\)[^;]*;/gi)].map(
      (m) => m[0],
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/grant\s+execute\s+on\s+function\s+public\.ops_health_report\(\)\s+to\s+service_role\s*;/i);
    for (const g of grants) {
      expect(g).not.toMatch(/\b(anon|authenticated|public)\b\s*;|\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    }
  });

  it("stays SECURITY DEFINER with an empty search_path", () => {
    const header = /create\s+or\s+replace\s+function\s+public\.ops_health_report\s*\([\s\S]*?\bas\s+\$[a-z_]*\$/i.exec(
      newest.code,
    )?.[0];
    expect(header).toBeDefined();
    expect(header).toMatch(/security\s+definer/i);
    expect(header).toMatch(/set\s+search_path\s*=\s*''/i);
  });
});
