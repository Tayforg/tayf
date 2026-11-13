import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 212 ("feed-window-overflow").
//
// haberport's feed holds its 50 newest items and changes once an hour. On
// weekdays more than 50 items appear between two polls, so 21-27% of its
// articles never reach Tayf and nothing recorded it. 212 adds the column ingest
// stamps when a poll of a full-sized window finds none of its urls stored
// (sources.fetch_window_overflow_at), a per-cycle counter
// (ingest_cycles.window_overflows), and lets the batched writer
// ingest_set_source_fetch_state carry the new key.
//
// This file pins:
//   * the migration is additive, in one transaction, and ends with the ledger
//     row in the 095 pattern;
//   * the writer's body is the LIVE body (read from production, md5 a3daf6ad...,
//     length 1522, which is 119's body) byte for byte, plus exactly two edits:
//     one recordset column and one coalesce assignment;
//   * signature, volatility, SECURITY DEFINER, search_path, revoke and grant
//     are the live function's;
//   * the 175 registry trigger's column list is unchanged and names no fetch_*
//     column, so the new write never moves registry_changed_at.
// No regular expression is applied to SQL text: only index scans and splits.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_212 = resolve(MIGRATIONS_DIR, "212_feed_window_overflow.sql");
const MIGRATION_119 = resolve(MIGRATIONS_DIR, "119_feed_freshness.sql");
const MIGRATION_175 = resolve(MIGRATIONS_DIR, "175_sources_registry_changed_at.sql");
const INGEST_INDEX = resolve(ROOT, "supabase", "functions", "ingest", "index.ts");

// Production, read-only, 2026-11-13: md5(prosrc) and length(prosrc) of
// public.ingest_set_source_fetch_state(jsonb).
const LIVE_MD5 = "a3daf6ad35bc73ff340dd9980fee7381";
const LIVE_LENGTH = 1522;

const COLUMN = "fetch_window_overflow_at";

/** Drops `--` comments line by line (no migration text under test has `--` inside a literal). */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

/** Whitespace collapsed to single spaces, trimmed (a character scan, no pattern). */
function norm(sql: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of sql) {
    if (isSpace(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n++;
    from = at + needle.length;
  }
}

/** The raw text between the two `$$` quotes of the function, or throws. */
function dollarBody(sql: string, exactlyTwo = false): string {
  const fn = sql.indexOf("create or replace function public.ingest_set_source_fetch_state");
  expect(fn, "function statement present").toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("$$", fn);
  const close = sql.indexOf("$$", open + 2);
  expect(open, "opening $$").toBeGreaterThan(fn);
  expect(close, "closing $$").toBeGreaterThan(open);
  if (exactlyTwo) expect(sql.indexOf("$$", close + 2), "exactly two $$ after the function start").toBe(-1);
  return sql.slice(open + 2, close);
}

/** The statements of `code` outside the $$ body, each normalised, in order. */
function outsideStatements(code: string): string[] {
  const open = code.indexOf("$$");
  const close = code.indexOf("$$", open + 2);
  const outside = `${code.slice(0, open)} $$ $$ ${code.slice(close + 2)}`;
  return outside
    .split(";")
    .map(norm)
    .filter((s) => s.length > 0);
}

/** Everything of one function statement before its `$$` body, normalised. */
function functionHeader(sql: string): string {
  const fn = sql.indexOf("create or replace function public.ingest_set_source_fetch_state");
  return norm(sql.slice(fn, sql.indexOf("$$", fn)));
}

let sql = "";
let code = "";
let sql119 = "";
let sql175 = "";
let body212 = "";
let body119 = "";
let statements: string[] = [];

beforeAll(() => {
  sql = readFileSync(MIGRATION_212, "utf8");
  code = stripSqlComments(sql);
  sql119 = readFileSync(MIGRATION_119, "utf8");
  sql175 = readFileSync(MIGRATION_175, "utf8");
  body212 = dollarBody(code, true);
  body119 = dollarBody(stripSqlComments(sql119));
  statements = outsideStatements(code);
});

describe("212 ledger, structure and header", () => {
  it("is one transaction: begin, set local lock_timeout = '5s', ..., ledger insert, commit", () => {
    expect(countOf(norm(code), "begin;")).toBe(1);
    expect(countOf(norm(code), "commit;")).toBe(1);
    const flat = norm(code);
    expect(flat.startsWith("begin; set local lock_timeout = '5s';")).toBe(true);
    expect(
      flat.endsWith(
        "insert into supabase_migrations.schema_migrations (version, name) values ('212', '212_feed_window_overflow') on conflict do nothing; commit;",
      ),
    ).toBe(true);
  });

  it("records itself as version '212' in the 095 pattern, once, and writes no other row anywhere", () => {
    expect(countOf(norm(code), "insert into ")).toBe(1);
    expect(countOf(norm(code), "values ('212', '212_feed_window_overflow') on conflict do nothing;")).toBe(1);
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(sql.length).toBeGreaterThan(3000);
  });

  it("runs in the order columns, writer, grant, schema reload, ledger", () => {
    const flat = norm(code);
    const at = (needle: string): number => {
      const i = flat.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const sources = at("alter table public.sources");
    const cycles = at("alter table public.ingest_cycles");
    const writer = at("create or replace function public.ingest_set_source_fetch_state");
    const revoke = at("revoke execute on function public.ingest_set_source_fetch_state");
    const grant = at("grant execute on function public.ingest_set_source_fetch_state");
    const notify = at("notify pgrst, 'reload schema';");
    const ledger = at("insert into supabase_migrations.schema_migrations");
    // ingest_cycles first, sources last: the same order public.ops_health_report() reads them (no lock-order inversion)
    expect(sources).toBeGreaterThan(cycles);
    expect(writer).toBeGreaterThan(sources);
    expect(revoke).toBeGreaterThan(writer);
    expect(grant).toBeGreaterThan(revoke);
    expect(notify).toBeGreaterThan(grant);
    expect(ledger).toBeGreaterThan(notify);
  });

  it("the header documents WHY, STEP 0, REPLAY, ORDER, the unknown-key check, rollback and idempotence", () => {
    const head = sql.slice(0, sql.indexOf("\nbegin;"));
    for (const word of [
      "WHY",
      "WHAT CHANGES",
      "STEP 0",
      "REPLAY",
      "ORDER",
      "ROLLBACK",
      "haberport",
      "jsonb_to_recordset",
    ]) {
      expect(head, word).toContain(word);
    }
    const lower = head.toLowerCase();
    for (const phrase of ["detection and disclosure only", "recovering them", "safe to re-apply"]) {
      expect(lower, phrase).toContain(phrase);
    }
    // Step 0 facts recorded: the live function's md5 and length
    expect(head).toContain(LIVE_MD5);
    expect(head).toContain(String(LIVE_LENGTH));
    expect(head).toContain("119_feed_freshness.sql");
    // the deploy order
    expect(head).toContain("APPLY 212 FIRST");
    // the rollback restores 119's body and removes the ledger row
    expect(head).toContain("delete from supabase_migrations.schema_migrations where version = '212'");
    // no backfill
    expect(lower).toContain("no backfill");
    // the lock-order note names both failure codes: a busy table (55P03) and a deadlock (40P01)
    expect(head).toContain("55P03");
    expect(head).toContain("40P01");
  });
});

describe("212 additive shape", () => {
  it("the statements outside the writer's body are exactly the ones the spec lists, in order", () => {
    // The leading words that name the statement (a comment literal can hold anything after them).
    const names = statements.map((s) => s.split(" ").slice(0, 4).join(" "));
    expect(names).toEqual([
      "begin",
      "set local lock_timeout =",
      "alter table public.ingest_cycles add",
      "comment on column public.ingest_cycles.window_overflows",
      "alter table public.sources add",
      "comment on column public.sources.fetch_window_overflow_at",
      "create or replace function",
      "comment on function public.ingest_set_source_fetch_state(jsonb)",
      "revoke execute on function",
      "grant execute on function",
      "notify pgrst, 'reload schema'",
      "insert into supabase_migrations.schema_migrations (version,",
      "commit",
    ]);
  });

  it("adds the two columns: nullable, no default, no not null, `add column if not exists`, one alter each", () => {
    expect(statements).toContain(
      "alter table public.sources add column if not exists fetch_window_overflow_at timestamptz",
    );
    expect(statements).toContain(
      "alter table public.ingest_cycles add column if not exists window_overflows integer",
    );
    const alters = statements.filter((s) => s.startsWith("alter "));
    expect(alters).toHaveLength(2);
    for (const a of alters) {
      expect(a).not.toContain(" default ");
      expect(a).not.toContain(" not null");
      expect(a).not.toContain(" drop ");
      expect(a).not.toContain(" rename ");
      expect(a).not.toContain(" type ");
    }
  });

  it("comments both columns, and the sources comment says what NULL and a date mean", () => {
    const sources = statements.find((s) => s.startsWith("comment on column public.sources.fetch_window_overflow_at is '"));
    const cycles = statements.find((s) => s.startsWith("comment on column public.ingest_cycles.window_overflows is '"));
    expect(sources).toBeDefined();
    expect(cycles).toBeDefined();
    expect(sources).toContain("migration 212");
    expect(sources).toContain("NULL");
    expect(sources).toContain("none of its items was stored before");
    expect(cycles).toContain("migration 212");
  });

  it("outside the writer's body: no create other than the function, no drop, delete, truncate, update, vacuum, cron or backfill", () => {
    const outside = statements.filter((s) => !s.startsWith("comment on "));
    for (const s of outside) {
      for (const bad of ["create table", "create index", "create unique", "create trigger", "drop ", "delete ", "truncate", "update ", "vacuum", "cron.", "alter default"]) {
        expect(s.includes(bad), `${bad} in: ${s.slice(0, 80)}`).toBe(false);
      }
    }
    expect(statements.filter((s) => s.startsWith("create "))).toHaveLength(1);
    // the only INSERT is the ledger row
    expect(statements.filter((s) => s.includes("insert into "))).toHaveLength(1);
    // no UPDATE and no DELETE outside the function: the existing rows are not touched
    expect(statements.some((s) => s.startsWith("update "))).toBe(false);
  });

  it("the writer's body has exactly one UPDATE and no insert, delete or truncate", () => {
    const flat = norm(body212);
    expect(countOf(flat, "update ")).toBe(1);
    expect(flat.startsWith("declare v_changed integer; begin update public.sources s set ")).toBe(true);
    for (const bad of ["insert ", "delete ", "truncate", "execute ", "drop "]) {
      expect(flat.includes(bad), bad).toBe(false);
    }
  });
});

describe("212 grant surface: unchanged", () => {
  it("revokes execute from anon, authenticated and public, and grants it to service_role only", () => {
    expect(statements.filter((s) => s.startsWith("revoke "))).toEqual([
      "revoke execute on function public.ingest_set_source_fetch_state(jsonb) from anon, authenticated, public",
    ]);
    expect(statements.filter((s) => s.startsWith("grant "))).toEqual([
      "grant execute on function public.ingest_set_source_fetch_state(jsonb) to service_role",
    ]);
  });

  it("the revoke and the grant are 119's, word for word", () => {
    const s119 = outsideStatements(stripSqlComments(sql119));
    for (const prefix of ["revoke execute on function public.ingest_set_source_fetch_state", "grant execute on function public.ingest_set_source_fetch_state"]) {
      const a = s119.find((s) => s.startsWith(prefix));
      const b = statements.find((s) => s.startsWith(prefix));
      expect(a, `119 ${prefix}`).toBeDefined();
      expect(b, `212 ${prefix}`).toBe(a);
    }
  });

  it("no grant of any kind on a table or a column, and none for anon, authenticated or public", () => {
    for (const s of statements.filter((x) => x.startsWith("grant "))) {
      expect(s).toContain("on function");
      expect(s.endsWith(" to service_role")).toBe(true);
    }
    expect(norm(code)).not.toContain("on public.sources to");
    expect(norm(code)).not.toContain("(fetch_window_overflow_at) to");
  });
});

describe("212 ingest_set_source_fetch_state: the live body plus one key", () => {
  it("sanity: 119's body is the live body (md5 and length read from production on 2026-11-13)", () => {
    expect(body119.length).toBe(LIVE_LENGTH);
    expect(createHash("md5").update(body119).digest("hex")).toBe(LIVE_MD5);
  });

  it("keeps the live header: signature, returns integer, plpgsql, SECURITY DEFINER, search_path = '', volatile (no volatility keyword)", () => {
    const header = functionHeader(code);
    expect(header).toBe(functionHeader(stripSqlComments(sql119)));
    expect(header).toBe(
      "create or replace function public.ingest_set_source_fetch_state(p_rows jsonb) returns integer language plpgsql security definer set search_path = '' as",
    );
    for (const kw of [" stable", " immutable", " strict", " leakproof", " parallel "]) {
      expect(header.includes(kw), kw).toBe(false);
    }
  });

  it("the body is the live body byte for byte with exactly two insertions: the coalesce assignment and the recordset column", () => {
    const tailOfSet = "           else greatest(r.fetch_items_count, 0)\n         end\n    from pg_catalog.jsonb_to_recordset(p_rows) as r(";
    const setWithNew =
      "           else greatest(r.fetch_items_count, 0)\n         end,\n         fetch_window_overflow_at = coalesce(r.fetch_window_overflow_at, s.fetch_window_overflow_at)\n    from pg_catalog.jsonb_to_recordset(p_rows) as r(";
    const tailOfCols = "           fetch_items_count int\n         )\n   where s.id = r.id;";
    const colsWithNew =
      "           fetch_items_count int,\n           fetch_window_overflow_at timestamptz\n         )\n   where s.id = r.id;";
    expect(countOf(body119, tailOfSet), "live set tail occurs once").toBe(1);
    expect(countOf(body119, tailOfCols), "live column tail occurs once").toBe(1);
    const expected = body119.split(tailOfSet).join(setWithNew).split(tailOfCols).join(colsWithNew);
    expect(expected.length).toBeGreaterThan(body119.length);
    expect(body212).toBe(expected);
  });

  it("the new assignment is coalesce(r.x, s.x): a poll without the key keeps the stored time, never nulls it", () => {
    const flat = norm(body212);
    const good = "fetch_window_overflow_at = coalesce(r.fetch_window_overflow_at, s.fetch_window_overflow_at)";
    expect(countOf(flat, good)).toBe(1);
    expect(countOf(flat, "fetch_window_overflow_at = r.fetch_window_overflow_at")).toBe(0);
    expect(countOf(flat, "fetch_window_overflow_at = least(")).toBe(0);
    // the column is read once as the payload's and once as the stored one in the assignment, plus the recordset declaration
    expect(countOf(flat, "fetch_window_overflow_at")).toBe(4);
  });

  it("the assignments before fetch_items_count and the join are the live body's, untouched", () => {
    const set = (b: string): string => {
      const start = b.indexOf("set fetch_etag");
      const end = b.indexOf("fetch_items_count = case");
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      return norm(b.slice(start, end));
    };
    expect(set(body212)).toBe(set(body119));
    expect(set(body212)).toContain("fetch_quarantined_until = case");
    expect(set(body212)).toContain("fetch_newest_item_at = case");
    const tail = (b: string): string => norm(b.slice(b.indexOf("where s.id = r.id")));
    expect(tail(body212)).toBe("where s.id = r.id; get diagnostics v_changed = row_count; return v_changed; end;");
    expect(tail(body212)).toBe(tail(body119));
  });

  it("the recordset column list is the live one plus the new key, last", () => {
    const cols = (b: string): string => {
      const start = b.indexOf("as r(");
      const end = b.indexOf(")", start);
      return norm(b.slice(start + "as r(".length, end));
    };
    expect(cols(body212)).toBe(`${cols(body119)}, fetch_window_overflow_at timestamptz`);
  });

  it("the function comment names migration 212, the new key and the coalesce, and keeps the earlier text", () => {
    const stmt = statements.find((s) => s.startsWith("comment on function public.ingest_set_source_fetch_state(jsonb) is '"));
    expect(stmt).toBeDefined();
    const text = stmt as string;
    expect(text).toContain("migration 212");
    expect(text).toContain("fetch_window_overflow_at");
    expect(text).toContain("coalesce");
    expect(text).toContain("migration 119");
    expect(text).toContain("least(null, x)");
    expect(text).toContain("Returns rows updated");
  });
});

describe("212 and the 175 registry trigger", () => {
  /** The WHEN clause of the trigger in 175: the text between `when (` and its matching `)`. */
  function whenClause(src: string): string {
    const create = src.indexOf("create trigger sources_registry_changed_at_trg");
    expect(create, "175 creates the trigger").toBeGreaterThanOrEqual(0);
    const open = src.indexOf("when (", create);
    expect(open).toBeGreaterThan(create);
    let depth = 0;
    for (let i = open + "when ".length; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) return src.slice(open + "when (".length, i);
      }
    }
    throw new Error("unbalanced when clause");
  }

  it("175's column list is the same fifteen registry columns and names no fetch_* column", () => {
    const when = norm(whenClause(stripSqlComments(sql175)));
    const terms = when.split(" or ").map((t) => t.trim());
    expect(terms).toHaveLength(15);
    const cols = terms.map((t) => {
      const [left, right] = t.split(" is distinct from ");
      expect(left?.startsWith("old."), t).toBe(true);
      expect(right?.startsWith("new."), t).toBe(true);
      expect(left?.slice(4), t).toBe(right?.slice(4));
      return (left as string).slice(4);
    });
    expect(cols).toEqual([
      "name",
      "slug",
      "url",
      "rss_url",
      "bias",
      "kind",
      "active",
      "logo_url",
      "tradition",
      "source_type",
      "image_allowed",
      "excerpt_allowed",
      "zone_rationale",
      "trustee_since",
      "trustee_note",
    ]);
    expect(when).not.toContain("fetch_");
    expect(when).not.toContain(COLUMN);
  });

  it("212 does not create, drop, alter or comment the trigger or its function, and does not name registry_changed_at in code", () => {
    const flat = norm(code);
    expect(flat).not.toContain("sources_registry_changed_at_trg");
    expect(flat).not.toContain("sources_touch_registry_changed_at");
    expect(flat).not.toContain("registry_changed_at");
  });
});

describe("212 and the ingest code", () => {
  it("ingest sends the key the writer reads, under the same name, and writes the counter column the migration adds", () => {
    const ingest = readFileSync(INGEST_INDEX, "utf8");
    expect(ingest).toContain(`${COLUMN}?: string`);
    expect(ingest).toContain("state.fetch_window_overflow_at = windowOverflowAt");
    expect(ingest).toContain("window_overflows: stats.windowOverflows");
    // both names are in the migration's code
    expect(norm(code)).toContain(`${COLUMN} timestamptz`);
    expect(norm(code)).toContain("window_overflows integer");
  });
});
