import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { isValidSourceUrl } from "@/lib/validation/source-input";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 093 (feed registry repoint).
//
// 093 is data-only: it repoints sources.rss_url for outlets whose old feed URL
// is dead or moved and whose replacement was verified (docs/
// feed-registry-2026-09.md). Every row is backed up in the same statement as
// the update, and nothing is ever deactivated, deleted or relabelled. No
// network access here: the evidence lives in the doc, this file pins the SQL.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = resolve(REPO_ROOT, "supabase", "migrations", "093_feed_registry_repoint.sql");
const DOC = resolve(REPO_ROOT, "docs", "feed-registry-2026-09.md");

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const BANNED_HOST = /(^|\.)(news\.google\.com|feedburner\.com|feeds\.feedburner\.com|rss\.app|fetchrss\.com|politepol\.com|feed43\.com)$/i;
const ALLOWED_SET_COLUMNS = new Set([
  "rss_url",
  "fetch_fail_streak",
  "fetch_quarantined_until",
  "fetch_etag",
  "fetch_last_modified",
  "fetch_body_hash",
]);

describe("migration 093_feed_registry_repoint.sql (SQL contract)", () => {
  let code = "";
  const rows: Array<{ slug: string; old: string; next: string }> = [];

  beforeAll(() => {
    expect(existsSync(MIGRATION), "093 migration must exist").toBe(true);
    code = stripComments(readFileSync(MIGRATION, "utf8"));
    const values = code.match(/with\s+v\s*\(\s*slug\s*,\s*old_rss_url\s*,\s*new_rss_url\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*backup\s+as/i);
    expect(values, "VALUES CTE not found").not.toBeNull();
    const re = /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
    for (const m of (values![1] as string).matchAll(re)) {
      rows.push({ slug: m[1] as string, old: m[2] as string, next: m[3] as string });
    }
  });

  it("contains the ledger insert for '093'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'093'\s*,\s*'093_feed_registry_repoint'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("opens with begin and ends with commit", () => {
    expect(code.trim()).toMatch(/^begin\s*;/i);
    expect(code.trim()).toMatch(/\bcommit\s*;$/i);
  });

  it("never deletes, truncates or drops, and never touches active", () => {
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\bactive\s*=/i);
  });

  it("creates only sources_rss_backup_093, with if not exists", () => {
    const creates = [...code.matchAll(/\bcreate\s+table\b[^(]*/gi)].map((m) => m[0].replace(/\s+/g, " ").trim().toLowerCase());
    expect(creates).toEqual(["create table if not exists public.sources_rss_backup_093"]);
  });

  it("locks the backup table down: RLS on, revoke all, service_role select+insert", () => {
    expect(code).toMatch(/alter\s+table\s+public\.sources_rss_backup_093\s+enable\s+row\s+level\s+security/i);
    expect(code).toMatch(/revoke\s+all\s+on\s+public\.sources_rss_backup_093\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i);
    expect(code).toMatch(/grant\s+select\s*,\s*insert\s+on\s+public\.sources_rss_backup_093\s+to\s+service_role/i);
    expect(code).not.toMatch(/create\s+policy/i);
  });

  it("backs up in the same statement, before the update", () => {
    const ins = code.search(/insert\s+into\s+public\.sources_rss_backup_093\s*\(/i);
    const upd = code.search(/update\s+public\.sources\b/i);
    expect(ins).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(-1);
    expect(ins).toBeLessThan(upd);
    const insertBlock = code.slice(ins, upd);
    expect(insertBlock).toMatch(/on\s+conflict\s*\(\s*id\s*\)\s*do\s+nothing/i);
    expect(insertBlock).toMatch(/\breturning\b/i);
    const updateBlock = code.slice(upd);
    expect(updateBlock).toMatch(/from\s+backup\s+b\b/i);
    expect(updateBlock).toMatch(/s\.rss_url\s*=\s*b\.old_rss_url/i);
  });

  it("only assigns rss_url and the fetch-state columns; resets streak and quarantine", () => {
    const m = code.match(/update\s+public\.sources\s+s\s+set([\s\S]*?)from\s+backup/i);
    expect(m, "UPDATE SET list not found").not.toBeNull();
    const setList = m![1] as string;
    const assigned = [...setList.matchAll(/(\w+)\s*=/g)].map((x) => x[1] as string);
    expect(assigned.length).toBeGreaterThan(0);
    for (const col of assigned) expect(ALLOWED_SET_COLUMNS.has(col), `unexpected column ${col}`).toBe(true);
    expect(setList).toMatch(/fetch_fail_streak\s*=\s*0\b/i);
    expect(setList).toMatch(/fetch_quarantined_until\s*=\s*null\b/i);
    expect(setList).toMatch(/rss_url\s*=\s*b\.new_rss_url/i);
  });

  it("has at least one VALUES row and every row is a real, safe repoint", () => {
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.next, r.slug).not.toBe(r.old);
      expect(isValidSourceUrl(r.next), `${r.slug}: ${r.next}`).toBe(true);
      const host = new URL(r.next).hostname;
      expect(BANNED_HOST.test(host), `${r.slug}: banned host ${host}`).toBe(false);
      expect(/rsshub|rss-bridge/i.test(host), `${r.slug}: proxy host`).toBe(false);
    }
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.next)).size).toBe(rows.length);
  });

  it("evidence doc exists and names every slug and new URL", () => {
    expect(existsSync(DOC), "docs/feed-registry-2026-09.md must exist").toBe(true);
    const doc = readFileSync(DOC, "utf8");
    for (const r of rows) {
      expect(doc, `doc missing slug ${r.slug}`).toContain(r.slug);
      expect(doc, `doc missing url ${r.next}`).toContain(r.next);
    }
  });
});
