import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 094 (silent-feeds validator reset).
//
// 094 is data-only: it nulls fetch_etag / fetch_last_modified / fetch_body_hash
// for the sources whose validators were saved before their rows landed (see
// docs/feed-registry-2026-09.md, "Root cause (2026-09-29)"). The old values are
// backed up in the same statement. Nothing else on `sources` is touched.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = resolve(REPO_ROOT, "supabase", "migrations", "094_reset_poisoned_feed_validators.sql");
const DOC = resolve(REPO_ROOT, "docs", "feed-registry-2026-09.md");
const INGEST = resolve(REPO_ROOT, "supabase", "functions", "ingest", "index.ts");

// Five audited silent sources + journo (its feed had 2 items missing from articles).
const EXPECTED = [
  "iklim-haber",
  "investing-com-tr",
  "newslab-turkey",
  "platform-24",
  "turkiye-haber-ajansi",
  "journo",
];

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 094_reset_poisoned_feed_validators.sql (SQL contract)", () => {
  let code = "";
  let slugs: string[] = [];

  beforeAll(() => {
    expect(existsSync(MIGRATION), "094 migration must exist").toBe(true);
    code = stripComments(readFileSync(MIGRATION, "utf8"));
    const values = code.match(/with\s+v\s*\(\s*slug\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*backup\s+as/i);
    expect(values, "VALUES CTE not found").not.toBeNull();
    slugs = [...(values![1] as string).matchAll(/\(\s*'([^']*)'\s*\)/g)].map((m) => m[1] as string);
  });

  it("contains the ledger insert for '094'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'094'\s*,\s*'094_reset_poisoned_feed_validators'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("opens with begin and ends with commit", () => {
    expect(code.trim()).toMatch(/^begin\s*;/i);
    expect(code.trim()).toMatch(/\bcommit\s*;$/i);
  });

  it("never deletes, truncates or drops, and never touches rss_url/active/bias/kind", () => {
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\brss_url\s*=/i);
    expect(code).not.toMatch(/\bactive\s*=/i);
    expect(code).not.toMatch(/\bbias\b/i);
    expect(code).not.toMatch(/\bkind\s*=/i);
  });

  it("creates only sources_fetch_state_backup_094, with if not exists", () => {
    const creates = [...code.matchAll(/\bcreate\s+table\b[^(]*/gi)].map((m) =>
      m[0].replace(/\s+/g, " ").trim().toLowerCase(),
    );
    expect(creates).toEqual(["create table if not exists public.sources_fetch_state_backup_094"]);
  });

  it("locks the backup table down: RLS on, revoke all, service_role select+insert, no policy", () => {
    expect(code).toMatch(/alter\s+table\s+public\.sources_fetch_state_backup_094\s+enable\s+row\s+level\s+security/i);
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.sources_fetch_state_backup_094\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
    );
    expect(code).toMatch(/grant\s+select\s*,\s*insert\s+on\s+public\.sources_fetch_state_backup_094\s+to\s+service_role/i);
    expect(code).not.toMatch(/create\s+policy/i);
  });

  it("backs up in the same statement, before the update", () => {
    const ins = code.search(/insert\s+into\s+public\.sources_fetch_state_backup_094\s*\(/i);
    const upd = code.search(/update\s+public\.sources\b/i);
    expect(ins).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(-1);
    expect(ins).toBeLessThan(upd);
    const insertBlock = code.slice(ins, upd);
    expect(insertBlock).toMatch(/on\s+conflict\s*\(\s*id\s*\)\s*do\s+nothing/i);
    expect(insertBlock).toMatch(/\breturning\b/i);
    expect(code.slice(upd)).toMatch(/from\s+backup\s+b\b/i);
  });

  it("the SET list is exactly the three validator columns, each = null", () => {
    const m = code.match(/update\s+public\.sources\s+s\s+set([\s\S]*?)from\s+backup/i);
    expect(m, "UPDATE SET list not found").not.toBeNull();
    const setList = m![1] as string;
    const assigned = [...setList.matchAll(/(\w+)\s*=\s*(\w+)/g)].map((x) => [x[1], x[2]]);
    expect(assigned.map((a) => a[0]).sort()).toEqual(["fetch_body_hash", "fetch_etag", "fetch_last_modified"]);
    for (const [, value] of assigned) expect(value).toBe("null");
  });

  it("the VALUES slugs equal the EXPECTED list", () => {
    expect([...slugs].sort()).toEqual([...EXPECTED].sort());
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("the evidence doc names every slug", () => {
    expect(existsSync(DOC), "docs/feed-registry-2026-09.md must exist").toBe(true);
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toContain("Root cause (2026-09-29)");
    for (const slug of slugs) expect(doc, `doc missing slug ${slug}`).toContain(slug);
  });

  it("ingest still references all three columns (parity)", () => {
    const ingest = readFileSync(INGEST, "utf8");
    for (const col of ["fetch_etag", "fetch_last_modified", "fetch_body_hash"]) {
      expect(ingest, `ingest/index.ts must reference ${col}`).toContain(col);
    }
  });
});
