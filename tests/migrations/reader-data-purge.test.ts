import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static checks for migration 042 (rebase of 033's corrections.status
// vocabulary + reviewed_at + the purge_reader_data() DSAR function) and 043
// (its idempotent pg_cron schedule). Modelled on
// tests/migrations/retention-cron.test.ts's MIGRATIONS_DIR / read() /
// functionHeader() helpers. No live tier — see the psql dry-run transcript
// in the worker report for the behavioural checks (defaults, the rejected
// 'resolved' status, the 1/1 purge) that a static regex suite can't cover.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

// Slices out one `create or replace function <name>` header — everything
// between the signature and the `as $$` body delimiter — so SECURITY
// DEFINER / search_path assertions can be scoped to the right function
// instead of matching anywhere in the file.
function functionHeader(sql: string, fnName: string): string {
  const start = sql.indexOf(`create or replace function ${fnName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("as $$", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("migration 042_corrections_status.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("042_corrections_status.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("adds (or no-ops) status defaulting to 'open'", () => {
    expect(sql).toMatch(
      /add\s+column\s+if\s+not\s+exists\s+status\s+text\s+not\s+null\s+default\s+'open'/i,
    );
    expect(sql).toMatch(/alter\s+column\s+status\s+set\s+default\s+'open'/i);
  });

  it("drops 033's auto-named inline check before re-adding it", () => {
    expect(sql).toMatch(/drop\s+constraint\s+if\s+exists\s+corrections_status_check/i);
  });

  it("re-adds the check with exactly the open/reviewed/dismissed vocabulary", () => {
    expect(sql).toMatch(
      /add\s+constraint\s+corrections_status_check\s+check\s*\(\s*status\s+in\s*\(\s*'open'\s*,\s*'reviewed'\s*,\s*'dismissed'\s*\)\s*\)/i,
    );
  });

  it("remaps 033's retired vocabulary (new -> open, resolved -> dismissed)", () => {
    expect(sql).toMatch(/update\s+public\.corrections\s+set\s+status\s*=\s*'open'\s+where\s+status\s*=\s*'new'/i);
    expect(sql).toMatch(
      /update\s+public\.corrections\s+set\s+status\s*=\s*'dismissed'\s+where\s+status\s*=\s*'resolved'/i,
    );
  });

  it("adds reviewed_at as a nullable timestamptz", () => {
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+reviewed_at\s+timestamptz/i);
  });

  it("defines purge_reader_data(correction_months, unconfirmed_hours) as SECURITY DEFINER with empty search_path", () => {
    expect(sql).toMatch(
      /create\s+or\s+replace\s+function\s+public\.purge_reader_data\(\s*correction_months\s+int\s+default\s+12\s*,\s*unconfirmed_hours\s+int\s+default\s+48\s*\)/i,
    );
    const header = functionHeader(sql, "public.purge_reader_data");
    expect(header).toMatch(/security\s+definer/i);
    expect(header).toMatch(/set\s+search_path\s*=\s*''/i);
  });

  it("deletes only from corrections and newsletter_subscribers — never clusters/articles/cluster_articles", () => {
    expect(sql).toMatch(/delete\s+from\s+public\.corrections/i);
    expect(sql).toMatch(/delete\s+from\s+public\.newsletter_subscribers/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.(clusters|articles|cluster_articles)/i);
  });

  it("the newsletter delete only targets unconfirmed rows", () => {
    const start = sql.indexOf("delete from public.newsletter_subscribers");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = sql.indexOf(";", start);
    expect(end).toBeGreaterThan(start);
    const stmt = sql.slice(start, end);
    expect(stmt).toMatch(/confirmed_at\s+is\s+null/i);
  });

  it("uses make_interval with the named arguments for each window", () => {
    expect(sql).toMatch(/make_interval\(months\s*=>\s*correction_months\)/i);
    expect(sql).toMatch(/make_interval\(hours\s*=>\s*unconfirmed_hours\)/i);
  });

  it("returns a schema-qualified jsonb_build_object with the two deletion counts", () => {
    expect(sql).toMatch(/pg_catalog\.jsonb_build_object/);
    expect(sql).toMatch(/'corrections_deleted'/);
    expect(sql).toMatch(/'subscribers_deleted'/);
  });

  it("revokes/grants purge_reader_data per the service_role-only convention", () => {
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.purge_reader_data\(int,\s*int\)\s+from\s+[^;]*\banon\b[^;]*\bauthenticated\b[^;]*\bpublic\b/i,
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.purge_reader_data\(int,\s*int\)\s+to\s+service_role/i,
    );
  });

  it("does not create or drop an index — 033's corrections_status_created_at_idx is untouched", () => {
    expect(sql).not.toMatch(/create\s+index/i);
    expect(sql).not.toMatch(/drop\s+index/i);
  });
});

describe("migration 043_reader_data_purge_cron.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("043_reader_data_purge_cron.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("schedules exactly one job: reader-data-purge", () => {
    const jobnames = [...sql.matchAll(/cron\.schedule\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
    expect(jobnames).toEqual(["reader-data-purge"]);
  });

  it("runs at 04:40 UTC, clear of 038's 04:10 prune-nightly", () => {
    expect(sql).toMatch(/'reader-data-purge'[\s\S]{0,20}'40 4 \* \* \*'/);
  });

  it("job body calls purge_reader_data() with no arguments", () => {
    const jobBody = sql.slice(sql.indexOf("'reader-data-purge'"));
    expect(jobBody).toMatch(/purge_reader_data\(\)/);
  });

  it("guards on pg_cron only, with a NOTICE (not an error) when absent", () => {
    expect(sql).toMatch(/pg_extension\s+where\s+extname\s*=\s*'pg_cron'/i);
    expect(sql).toMatch(/raise\s+notice/i);
  });

  it("needs no pg_net, Vault secret, or net.http_post — it's a pure SQL job", () => {
    expect(sql).not.toMatch(/pg_net/i);
    expect(sql).not.toMatch(/vault\./i);
    expect(sql).not.toMatch(/net\.http_post/i);
  });

  it("unschedules by jobname before rescheduling (idempotent re-apply)", () => {
    expect(sql).toMatch(/cron\.unschedule/i);
    expect(sql).toMatch(/if\s+exists\s*\([^)]*from\s+cron\.job\s+where\s+jobname/i);
  });

  it("does not touch any of 038's four jobs", () => {
    expect(sql).not.toMatch(/ingest-drain|cluster-drain|image-drain|prune-nightly/);
  });
});
