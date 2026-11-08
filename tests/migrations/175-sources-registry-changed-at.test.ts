import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 175 ("sources-registry-changed-at"), h69-jsonld-1.
//
// /sources prints a Dataset JSON-LD block whose dateModified was the latest of sources.created_at,
// sources.zone_rationale_at and the newest source_zone_history row. None of those moves when a source's kind, kayyum
// (trustee) status, rights flags, name, URL or active flag change, and sources has no updated_at, so the page said
// 2026-04-06 while 038/034 (kind, 2026-09-06) and 055 (trustee dates, 2026-09-18) had changed the registry months later.
// 175 adds sources.registry_changed_at (not null, default now()) and a BEFORE UPDATE row trigger that stamps it, but
// only when one of the 15 registry columns changes. The WHEN clause leaves out every column an automated job writes:
// ingest_set_source_fetch_state writes the nine fetch_* columns every few minutes, and counting them would make
// dateModified track ingest instead of the registry.
//
// This file pins: the statements (one transaction, lock_timeout, the column, the trigger function with its empty
// search_path and its revoke, the trigger and its exact WHEN clause, the schema-cache notice, the ledger row), what the
// migration does NOT do (no data change, no history backfill, no grant), the header, the docs section, the live manifest
// and the dry-run. The live block at the end runs the trigger against fixture rows through psql when TAYF_PSQL is set
// (every case rolled back).
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION_175 = resolve(ROOT, "supabase", "migrations", "175_sources_registry_changed_at.sql");
const DOC_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "175-sources-registry-changed-at-dryrun.sql");

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('175', '175_sources_registry_changed_at') on conflict do nothing";
const ADD_COLUMN_STMT =
  "alter table public.sources add column if not exists registry_changed_at timestamptz not null default now()";
const REVOKE_STMT = "revoke all on function public.sources_touch_registry_changed_at() from public, anon, authenticated";

/** The 15 registry columns the WHEN clause compares, in the order the finding lists them. */
const REGISTRY_COLUMNS = [
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
] as const;

/** Written by ingest_set_source_fetch_state (074, 119) every few minutes: never part of the registry stamp. */
const FETCH_COLUMNS = [
  "fetch_etag",
  "fetch_last_modified",
  "fetch_body_hash",
  "fetch_last_status",
  "fetch_last_at",
  "fetch_fail_streak",
  "fetch_quarantined_until",
  "fetch_newest_item_at",
  "fetch_items_count",
] as const;

/** The other columns of production's sources (read 2026-11-08) that the stamp ignores. */
const OTHER_COLUMNS = ["id", "created_at", "zone_rationale_at"] as const;

// -- character-scan helpers (no regular expression runs over SQL text) ----------

/** Index just past the quoted string or dollar-quoted body that opens at `i`; `i` itself when none opens there. */
function skipQuoted(sql: string, i: number): number {
  const ch = sql.charAt(i);
  if (ch === "'") {
    let j = i + 1;
    while (j < sql.length) {
      if (sql.charAt(j) === "'") {
        if (sql.charAt(j + 1) === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j += 1;
    }
    return j + 1;
  }
  if (ch === "$" && sql.charAt(i + 1) === "$") {
    const end = sql.indexOf("$$", i + 2);
    return end < 0 ? sql.length : end + 2;
  }
  return i;
}

/** Removes `--` comments (to the end of the line, newline kept); quoted strings and `$$` bodies are copied verbatim. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const stop = skipQuoted(sql, i);
    if (stop > i) {
      out += sql.slice(i, stop);
      i = stop;
    } else if (sql.charAt(i) === "-" && sql.charAt(i + 1) === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else {
      out += sql.charAt(i);
      i += 1;
    }
  }
  return out;
}

/** Splits comment-free SQL on `;`, not inside a quoted string or a `$$` body. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const stop = skipQuoted(sql, i);
    if (stop > i) {
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql.charAt(i) === ";") {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
    } else {
      cur += sql.charAt(i);
    }
    i += 1;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const collapse = (s: string): string => s.replaceAll("\n", " ").split(" ").filter(Boolean).join(" ");

/** Identifier-like words of the text, lower case. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || ch === "_" || (ch >= "0" && ch <= "9")) {
      cur += ch;
    } else if (cur) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** How many times `needle` occurs in `text` (non-overlapping). */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * The column each OR-term of a WHEN clause compares, or `?<term>` when a term is not exactly
 * `old.<c> is distinct from new.<c>` (a different operator, a different column on each side, an AND, a function call).
 */
function distinctColumns(clause: string): string[] {
  return clause.split(" or ").map((term) => {
    const w = term.trim().split(" ");
    const a = w[0] ?? "";
    const b = w[4] ?? "";
    const shaped = w.length === 5 && w[1] === "is" && w[2] === "distinct" && w[3] === "from";
    if (!shaped || !a.startsWith("old.") || !b.startsWith("new.") || a.slice(4) !== b.slice(4)) return `?${term}`;
    return a.slice(4);
  });
}

const raw = readFileSync(MIGRATION_175, "utf8");
const code = stripComments(raw);
const statements = splitStatements(code).map(collapse);
const fnStmt = statements.find((s) => s.startsWith("create or replace function ")) ?? "";
const triggerStmt = statements.find((s) => s.startsWith("create trigger ")) ?? "";

/** The text between `when (` and the closing parenthesis before `execute function`. */
function whenClauseOf(stmt: string): string {
  const open = stmt.indexOf(" when (");
  const close = stmt.lastIndexOf(") execute function ");
  return open >= 0 && close > open ? stmt.slice(open + " when (".length, close).trim() : "";
}
const whenClause = whenClauseOf(triggerStmt);

describe("175 statements", () => {
  it("is one transaction: begin, lock_timeout, the column, its comment, the function, the revoke, the trigger, the notice, the ledger row, commit", () => {
    const heads = statements.map((s) => s.slice(0, 60));
    expect(statements).toHaveLength(12);
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toBe("set local lock_timeout = '5s'");
    expect(statements[2]).toBe(ADD_COLUMN_STMT);
    expect(statements[3]?.startsWith("comment on column public.sources.registry_changed_at is '"), heads[3]).toBe(true);
    expect(statements[4]?.startsWith("create or replace function public.sources_touch_registry_changed_at() "), heads[4]).toBe(true);
    expect(statements[5]).toBe(REVOKE_STMT);
    expect(statements[6]).toBe("drop trigger if exists sources_registry_changed_at_trg on public.sources");
    expect(statements[7]?.startsWith("create trigger sources_registry_changed_at_trg "), heads[7]).toBe(true);
    expect(statements[8]?.startsWith("comment on trigger sources_registry_changed_at_trg on public.sources is '"), heads[8]).toBe(true);
    expect(statements[9]).toBe("notify pgrst, 'reload schema'");
    expect(statements[10]).toBe(LEDGER_STMT);
    expect(statements[11]).toBe("commit");
  });

  it("takes the lock_timeout before the first statement that locks sources", () => {
    expect(code.indexOf("set local lock_timeout = '5s'")).toBeGreaterThan(code.indexOf("begin;"));
    expect(code.indexOf("set local lock_timeout = '5s'")).toBeLessThan(code.indexOf("alter table"));
  });

  it("adds registry_changed_at as timestamptz not null default now(): a STABLE default is a fast default, no table rewrite", () => {
    expect(statements).toContain(ADD_COLUMN_STMT);
    expect(countOf(collapse(code), "alter table")).toBe(1);
    // exactly one column, nothing else altered on the table
    for (const w of ["drop", "rename", "type", "using", "validate"]) {
      expect(wordsOf(ADD_COLUMN_STMT), w).not.toContain(w);
    }
  });

  it("explains the column: the stamp, the migration-time start value, and why fetch_* is excluded", () => {
    const comment = statements[3] ?? "";
    for (const word of ["fast default", "rewrite", "dateModified", "fetch_", "migration"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("changes no existing data: no update, delete or truncate statement; the only insert is the ledger row", () => {
    for (const s of statements) {
      expect(s.startsWith("update "), s.slice(0, 40)).toBe(false);
      expect(s.startsWith("delete "), s.slice(0, 40)).toBe(false);
      expect(s.startsWith("truncate "), s.slice(0, 40)).toBe(false);
    }
    expect(statements.filter((s) => s.startsWith("insert "))).toEqual([LEDGER_STMT]);
    expect(wordsOf(fnStmt)).not.toContain("insert");
    expect(wordsOf(fnStmt)).not.toContain("delete");
    // the only drop is the trigger the migration itself creates (a re-apply re-creates it)
    expect(statements.filter((s) => wordsOf(s)[0] === "drop")).toEqual([
      "drop trigger if exists sources_registry_changed_at_trg on public.sources",
    ]);
  });

  it("does not backfill the append-only source_zone_history (a founder decision): the table is not named in the code", () => {
    expect(wordsOf(code)).not.toContain("source_zone_history");
    expect(wordsOf(code)).not.toContain("sources_record_zone_history");
  });

  it("grants nothing; the one mention of anon and authenticated is the revoke of the function", () => {
    expect(statements.filter((s) => s.startsWith("grant "))).toEqual([]);
    expect(wordsOf(code)).not.toContain("grant");
    const mentions = statements.filter((s) => wordsOf(s).includes("anon") || wordsOf(s).includes("authenticated"));
    expect(mentions).toEqual([REVOKE_STMT]);
    expect(code).not.toContain("to public");
  });

  it("asks PostgREST to reload its schema cache once (a new column on a table the app reads)", () => {
    expect(countOf(code, "notify pgrst, 'reload schema'")).toBe(1);
  });

  it("records itself in the ledger exactly once", () => {
    expect(countOf(raw, "insert into supabase_migrations.schema_migrations")).toBe(1);
    expect(countOf(raw, "'175_sources_registry_changed_at'")).toBe(1);
  });
});

describe("175 trigger function", () => {
  it("returns trigger, sets new.registry_changed_at := pg_catalog.now() and returns new", () => {
    expect(fnStmt).toContain("returns trigger");
    expect(fnStmt).toContain("language plpgsql");
    expect(fnStmt).toContain("new.registry_changed_at := pg_catalog.now();");
    expect(fnStmt).toContain("return new;");
  });

  it("has an empty search_path and calls now() only schema-qualified", () => {
    expect(fnStmt).toContain("set search_path = ''");
    expect(countOf(fnStmt, "now()")).toBe(1);
    expect(countOf(fnStmt, "pg_catalog.now()")).toBe(1);
  });

  it("is not SECURITY DEFINER (it only assigns a column of NEW) and touches no table", () => {
    expect(wordsOf(fnStmt)).not.toContain("security");
    expect(wordsOf(fnStmt)).not.toContain("definer");
    expect(countOf(fnStmt, "public.")).toBe(1); // its own name
  });

  it("is revoked from public, anon and authenticated (Supabase grants EXECUTE to anon and authenticated at creation)", () => {
    expect(statements).toContain(REVOKE_STMT);
    expect(statements.indexOf(REVOKE_STMT)).toBeGreaterThan(statements.indexOf(fnStmt));
    expect(statements.indexOf(REVOKE_STMT)).toBeLessThan(statements.indexOf(triggerStmt));
  });
});

describe("175 trigger", () => {
  it("is a BEFORE UPDATE FOR EACH ROW trigger on public.sources with a WHEN clause, running the stamp function", () => {
    expect(
      triggerStmt.startsWith("create trigger sources_registry_changed_at_trg before update on public.sources for each row when ("),
    ).toBe(true);
    expect(triggerStmt.endsWith(") execute function public.sources_touch_registry_changed_at()")).toBe(true);
    expect(countOf(triggerStmt, "create trigger")).toBe(1);
  });

  it("the WHEN clause is OR of old.c is distinct from new.c for exactly the 15 registry columns", () => {
    expect(whenClause).not.toBe("");
    const compared = distinctColumns(whenClause);
    expect(compared).toEqual([...REGISTRY_COLUMNS]);
    expect(new Set(compared).size).toBe(15);
    // null-safe comparison only: no plain <> or = between old and new, no AND
    expect(countOf(whenClause, "<>")).toBe(0);
    expect(countOf(whenClause, " and ")).toBe(0);
    expect(countOf(whenClause, " is distinct from ")).toBe(15);
  });

  it("the WHEN clause names no fetch_* column, not registry_changed_at itself, and none of id, created_at, zone_rationale_at", () => {
    expect(whenClause).not.toContain("fetch_");
    expect(whenClause).not.toContain("registry_changed_at");
    for (const col of FETCH_COLUMNS) expect(wordsOf(triggerStmt), col).not.toContain(col);
    for (const col of OTHER_COLUMNS) expect(wordsOf(whenClause), col).not.toContain(col);
  });

  it("registry columns, fetch_* columns and the three other columns are all 27 columns production's sources has, each once", () => {
    const all = [...REGISTRY_COLUMNS, ...FETCH_COLUMNS, ...OTHER_COLUMNS];
    expect(all).toHaveLength(27);
    expect(new Set(all).size).toBe(27);
  });

  it("has no UPDATE OF column list (the WHEN clause alone decides) and is documented with a comment", () => {
    expect(triggerStmt).not.toContain("update of");
    expect(statements[8]).toContain("fetch_");
  });

  it("distinctColumns flags a term that is not old.c is distinct from new.c", () => {
    expect(distinctColumns("old.a is distinct from new.a or old.b is distinct from new.b")).toEqual(["a", "b"]);
    expect(distinctColumns("old.a is distinct from new.b")).toEqual(["?old.a is distinct from new.b"]);
    expect(distinctColumns("old.a <> new.a")).toEqual(["?old.a <> new.a"]);
    expect(distinctColumns("old.a is distinct from new.a and new.fetch_x > 1")).toEqual([
      "?old.a is distinct from new.a and new.fetch_x > 1",
    ]);
    expect(distinctColumns("old.a is not distinct from new.a")).toEqual(["?old.a is not distinct from new.a"]);
  });
});

describe("175 header documents the change", () => {
  let header = "";
  beforeAll(() => {
    header = raw.slice(0, raw.indexOf("\nbegin;"));
  });

  it("names the finding, the evidence and the sections", () => {
    expect(header).toMatch(/^-- 175_sources_registry_changed_at\.sql/);
    for (const word of [
      "h69-jsonld-1",
      "2026-04-06",
      "dateModified",
      "034_source_kind",
      "055_source_zone_registry",
      "trustee_since",
      "source_zone_history",
      "WHY",
      "WHAT CHANGES",
    ]) {
      expect(header, word).toContain(word);
    }
  });

  it("lists every column an automated job writes and why none is in the WHEN clause", () => {
    expect(header).toContain("STEP 0");
    for (const col of FETCH_COLUMNS) expect(header, col).toContain(col);
    expect(header).toContain("ingest_set_source_fetch_state");
    expect(header).toContain("set_source_bias");
    expect(header).toContain("delete_source");
    expect(header).toContain("sources_zone_history_trg");
  });

  it("states the replay, the deploy order (apply first, then deploy), the verify queries, a rollback and what stays out", () => {
    expect(header).toContain("REPLAY");
    expect(header).toContain("DEPLOY: APPLY 175 FIRST");
    expect(header).toContain("VERIFY (read-only");
    expect(header).toContain("DRY RUN");
    expect(header).toContain("DRYRUN 175 OK");
    const rb = header.slice(header.indexOf("ROLLBACK"));
    expect(rb).toContain("drop trigger if exists sources_registry_changed_at_trg");
    expect(rb).toContain("drop function if exists public.sources_touch_registry_changed_at()");
    expect(rb).toContain("drop column if exists registry_changed_at");
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '175'");
    expect(header).toContain("OUT OF SCOPE");
    expect(header).toContain("KNOWN LIMIT");
  });
});

describe("175 docs", () => {
  const guide = readFileSync(DOC_GUIDE, "utf8");
  const at = guide.indexOf("\n## 175 ");
  const section = at < 0 ? "" : guide.slice(at, guide.indexOf("\n## ", at + 5) < 0 ? guide.length : guide.indexOf("\n## ", at + 5));

  it("has a migration-guide section 175 with the apply order", () => {
    expect(at).toBeGreaterThan(0);
    expect(section.split("\n")[1]).toContain("175");
    expect(section).toContain("APPLY 175");
  });

  it("names the evidence, the rule and the verify and rollback steps", () => {
    for (const word of [
      "h69-jsonld-1",
      "registry_changed_at",
      "dateModified",
      "2026-04-06",
      "fetch_",
      "ingest_set_source_fetch_state",
      "is distinct from",
      "source_zone_history",
      "Verify",
      "Rollback",
    ]) {
      expect(section, word).toContain(word);
    }
  });
});

describe("175 live manifest and dry-run", () => {
  it("builds 175's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 175-sources-registry-changed-at.test.ts"));
    expect(lines).toHaveLength(1);
    const setup = (lines[0] as string).split("|")[2] as string;
    expect(setup.trim().split(" ").filter(Boolean)).toEqual(["tests/migrations/sql/175-sources-registry-changed-at-dryrun.sql"]);
  });

  it("the dry-run builds production's column list, applies 175 twice and ends with its OK line", () => {
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "../../../supabase/migrations/175_sources_registry_changed_at.sql",
      "../../../supabase/migrations/175_sources_registry_changed_at.sql",
    ]);
    for (const col of [...REGISTRY_COLUMNS, ...FETCH_COLUMNS]) expect(sql, col).toContain(col);
    expect(sql.trimEnd().endsWith("select 'DRYRUN 175 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the trigger against fixture rows, on a throwaway Postgres with 175 applied
// (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the
// server. Every case ends in a rollback.
// ---------------------------------------------------------------------------

/** Production's sources columns, read 2026-11-08 (information_schema.columns), before 175. */
const PROD_COLUMNS_BEFORE = [...OTHER_COLUMNS, ...REGISTRY_COLUMNS, ...FETCH_COLUMNS];

const ROW_A = "00000000-0000-4000-8000-00000000000a";
const ROW_B = "00000000-0000-4000-8000-00000000000b";
const OLD_STAMP = "timestamptz '2020-01-01 00:00:00+00'";

/** A set-list that changes the column's value on row A, for every registry column (null-safe: the fixture leaves some null). */
const REGISTRY_CHANGES: Record<(typeof REGISTRY_COLUMNS)[number], string> = {
  name: "name = coalesce(name, '') || ' x'",
  slug: "slug = coalesce(slug, '') || '-x'",
  url: "url = coalesce(url, '') || 'x'",
  rss_url: "rss_url = coalesce(rss_url, '') || 'x'",
  bias: "bias = case when bias = 'center' then 'opposition' else 'center' end",
  kind: "kind = case when kind = 'outlet' then 'wire' else 'outlet' end",
  active: "active = not active",
  logo_url: "logo_url = coalesce(logo_url, '') || 'x'",
  tradition: "tradition = tradition || 'x'",
  source_type: "source_type = source_type || 'x'",
  image_allowed: "image_allowed = not image_allowed",
  excerpt_allowed: "excerpt_allowed = not excerpt_allowed",
  zone_rationale: "zone_rationale = coalesce(zone_rationale, '') || 'x'",
  trustee_since: "trustee_since = coalesce(trustee_since, date '2026-01-01') + 1",
  trustee_note: "trustee_note = coalesce(trustee_note, '') || 'x'",
};

/** A set-list for every column the stamp ignores and a job writes (the nine fetch_* of ingest, plus created_at, zone_rationale_at). */
const IGNORED_CHANGES: Record<(typeof FETCH_COLUMNS)[number] | "created_at" | "zone_rationale_at", string> = {
  fetch_etag: "fetch_etag = coalesce(fetch_etag, '') || 'x'",
  fetch_last_modified: "fetch_last_modified = coalesce(fetch_last_modified, '') || 'x'",
  fetch_body_hash: "fetch_body_hash = coalesce(fetch_body_hash, '') || 'x'",
  fetch_last_status: "fetch_last_status = coalesce(fetch_last_status, 0) + 1",
  fetch_last_at: "fetch_last_at = clock_timestamp()",
  fetch_fail_streak: "fetch_fail_streak = fetch_fail_streak + 1",
  fetch_quarantined_until: "fetch_quarantined_until = clock_timestamp() + interval '1 hour'",
  fetch_newest_item_at: "fetch_newest_item_at = clock_timestamp()",
  fetch_items_count: "fetch_items_count = coalesce(fetch_items_count, 0) + 1",
  created_at: "created_at = created_at + interval '1 day'",
  zone_rationale_at: "zone_rationale_at = clock_timestamp()",
};

describe.runIf(Boolean(process.env.TAYF_PSQL))("175 registry_changed_at trigger against fixture rows (live Postgres, every case rolled back)", () => {
  assertLiveReady("175", { ledger: ["175"], relations: ["public.sources"], functions: ["public.sources_touch_registry_changed_at()"] });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  /** Two sources, so a case can show that only the updated row moves. */
  const ROWS = `insert into public.sources (id, slug, name, bias, url, rss_url, kind) values
  ('${ROW_A}', 'live-a', 'A', 'center', 'https://a.example', 'https://a.example/rss', 'outlet'),
  ('${ROW_B}', 'live-b', 'B', 'center', 'https://b.example', 'https://b.example/rss', 'outlet');
`;
  /** Puts every stamp back to an old value (a write of registry_changed_at alone does not fire the trigger). */
  const RESET = `update public.sources set registry_changed_at = ${OLD_STAMP};\n`;

  /** Which rows' stamps have moved off the old value: `a:true,b:false`. */
  const MOVED = `select string_agg(right(id::text, 1) || ':' || (registry_changed_at > ${OLD_STAMP})::text, ',' order by id) from public.sources;`;

  /** Inserts the rows, runs `setup`, resets the stamps, runs `change` and returns which rows' stamps moved. Rolled back. */
  function moved(change: string, setup = ""): string {
    return runPsql(`begin;\n${ROWS}${setup}\n${RESET}${change}\n${MOVED}\nrollback;\n`).trim();
  }

  it("the probe tables cover exactly the registry columns and the ignored columns", () => {
    expect(Object.keys(REGISTRY_CHANGES)).toEqual([...REGISTRY_COLUMNS]);
    expect(Object.keys(IGNORED_CHANGES).sort()).toEqual([...FETCH_COLUMNS, "created_at", "zone_rationale_at"].sort());
  });

  it("sources has production's 27 columns plus registry_changed_at, nothing else (so the dry-run's prelude is faithful)", () => {
    const cols = runPsql(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sources' order by column_name;",
    )
      .split("\n")
      .filter(Boolean);
    expect(cols).toEqual([...PROD_COLUMNS_BEFORE, "registry_changed_at"].sort());
  });

  it("registry_changed_at is timestamptz, not null, default now()", () => {
    const out = runPsql(
      "select data_type || '|' || is_nullable || '|' || coalesce(column_default, '') from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name = 'registry_changed_at';",
    ).trim();
    expect(out).toBe("timestamp with time zone|NO|now()");
  });

  it.each(REGISTRY_COLUMNS.map((c) => [c] as const))("a change to %s moves that row's stamp and no other row's", (col) => {
    expect(moved(`update public.sources set ${REGISTRY_CHANGES[col]} where id = '${ROW_A}';`)).toBe("a:true,b:false");
  });

  it.each(Object.keys(IGNORED_CHANGES).map((c) => [c] as const))("a change to %s alone leaves every stamp where it was", (col) => {
    const set = IGNORED_CHANGES[col as keyof typeof IGNORED_CHANGES];
    expect(moved(`update public.sources set ${set} where id = '${ROW_A}';`)).toBe("a:false,b:false");
  });

  it("ingest's update (all nine fetch_* columns on every row, one statement) moves nothing", () => {
    const set = FETCH_COLUMNS.map((c) => IGNORED_CHANGES[c]).join(",\n  ");
    expect(moved(`update public.sources set\n  ${set};`)).toBe("a:false,b:false");
  });

  it("an update that changes a registry column and fetch_* columns together does move the stamp", () => {
    const set = `${REGISTRY_CHANGES.kind}, ${IGNORED_CHANGES.fetch_fail_streak}, ${IGNORED_CHANGES.fetch_last_at}`;
    expect(moved(`update public.sources set ${set} where id = '${ROW_A}';`)).toBe("a:true,b:false");
  });

  it("an update that writes a registry column its own value does not move the stamp (is distinct from, not 'was assigned')", () => {
    expect(moved(`update public.sources set kind = kind, name = name, active = active, trustee_since = trustee_since;`)).toBe("a:false,b:false");
    expect(moved(`update public.sources set name = name, ${IGNORED_CHANGES.fetch_fail_streak};`)).toBe("a:false,b:false");
  });

  it("is null-safe: null -> value and value -> null both move the stamp, null -> null does not", () => {
    // trustee_since starts null in the fixture
    expect(moved(`update public.sources set trustee_since = date '2026-09-18' where id = '${ROW_A}';`)).toBe("a:true,b:false");
    expect(
      moved(`update public.sources set trustee_since = null where id = '${ROW_A}';`, `update public.sources set trustee_since = date '2026-09-18';`),
    ).toBe("a:true,b:false");
    expect(moved(`update public.sources set trustee_since = null, zone_rationale = null where id = '${ROW_A}';`)).toBe("a:false,b:false");
  });

  it("a multi-row update stamps exactly the rows whose registry columns changed", () => {
    expect(moved(`update public.sources set active = (id = '${ROW_B}');`)).toBe("a:true,b:false");
    expect(moved(`update public.sources set active = false;`)).toBe("a:true,b:true");
  });

  it("an explicit write of registry_changed_at alone is kept (only a registry-column change re-stamps)", () => {
    const out = runPsql(
      `begin;\n${ROWS}update public.sources set registry_changed_at = timestamptz '2021-06-01 00:00:00+00' where id = '${ROW_A}';\nselect registry_changed_at = timestamptz '2021-06-01 00:00:00+00' from public.sources where id = '${ROW_A}';\nrollback;\n`,
    ).trim();
    expect(out).toBe("t");
  });

  it("a moved stamp is the transaction time (pg_catalog.now())", () => {
    const out = runPsql(
      `begin;\n${ROWS}update public.sources set ${REGISTRY_CHANGES.kind} where id = '${ROW_A}';\nselect registry_changed_at = now() from public.sources where id = '${ROW_A}';\nrollback;\n`,
    ).trim();
    expect(out).toBe("t");
  });

  it("a new row gets its own insert time, not the migration's", () => {
    const out = runPsql(
      `begin;\ninsert into public.sources (id, slug, name, bias, url, rss_url) values ('${ROW_A}', 'live-a', 'A', 'center', 'https://a.example', 'https://a.example/rss');\nselect registry_changed_at = now() from public.sources where id = '${ROW_A}';\nrollback;\n`,
    ).trim();
    expect(out).toBe("t");
  });

  it("the trigger is one enabled BEFORE UPDATE row trigger whose definition names no fetch_* column", () => {
    const out = runPsql(
      `select tgenabled::text || '|' || tgtype::text || '|' || pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.sources'::regclass and tgname = 'sources_registry_changed_at_trg' and not tgisinternal;`,
    ).trim();
    const [enabled, tgtype, def] = out.split("|") as [string, string, string];
    expect(enabled).toBe("O");
    // 1 row + 2 before + 16 update
    expect(tgtype).toBe("19");
    expect(def).toContain("BEFORE UPDATE ON public.sources FOR EACH ROW WHEN");
    expect(def).not.toContain("fetch_");
    expect(def).not.toContain("registry_changed_at IS DISTINCT");
  });

  it("the function has an empty search_path, is not SECURITY DEFINER and is executable by none of public, anon, authenticated", () => {
    const out = runPsql(
      `select (p.proconfig = array['search_path=""'])::text || '|' || p.prosecdef::text || '|' || has_function_privilege('anon', p.oid, 'execute')::text || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text || '|' || (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))::text from pg_proc p where p.oid = 'public.sources_touch_registry_changed_at()'::regprocedure;`,
    ).trim();
    expect(out).toBe("true|false|false|false|false");
  });

  it("the ledger holds 175 once", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '175';").trim()).toBe("1");
  });
});
