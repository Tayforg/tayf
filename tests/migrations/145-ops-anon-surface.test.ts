import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALLOWED_RPCS, ALLOWED_RPC_IDENTITIES } from "../_helpers/anon-rpc-allowlist";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 145 ("ops-anon-surface-check"), h19-security-1.
//
// tests/guards/anon-surface.test.ts only reads migration TEXT. A grant made in the
// Supabase dashboard, or through supabase_admin's default ACL (which postgres cannot
// alter), never appears in a migration, so CI cannot see it. 145 re-creates
// public.ops_health_report() with one more row, `anon_surface`: a runtime check of
// what anon and authenticated can actually do, read from the catalogue by
// has_table_privilege / has_sequence_privilege / has_function_privilege and the
// relation ACLs. Its only DB change is that function (comment, revoke and grant as
// in 136); no policy, grant or data changes.
//
// This file pins: the byte identity of rows 1-16 against 136, the new row's
// contract, the allowlist (the same constant as the anon-surface guard), the
// grants (exactly 136's two), the function comment and the header. It is static;
// the live proof is in the DRY RUNS of the migration header.
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_145 = resolve(MIGRATIONS_DIR, "145_ops_anon_surface_check.sql");
const MIGRATION_136 = resolve(MIGRATIONS_DIR, "136_ops_heartbeat_app_side.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_OPS_HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");

const CHECK_17 = "anon_surface";

const ROW_NAMES_17 = [
  "cron_failed_runs_30m",
  "edge_http_errors_30m",
  "ingest_cycles_30m",
  "ingest_fresh_iktidar_min",
  "ingest_fresh_bagimsiz_min",
  "ingest_fresh_muhalefet_min",
  "jev_shadow_last_run_min",
  "blindspot_veto_cron_min",
  "jev_alerts_unacked_72h",
  "dead_feeds",
  "net_response_heap_mb",
  "jev_shadow_cron_failures_30m",
  "sources_newly_dark",
  "ingest_gaps",
  "cron_route_failures_30m",
  "db_size_mb",
  CHECK_17,
];

const CREATE_LINE = "create or replace function public.ops_health_report()";
const MARKER_17 = "-- 17. anon_surface (migration 145).";
/** What follows row 16's `return next;` in 136, and now follows row 17's. */
const FN_END = "\n\n  return;\nend\n$fn$;";

const REVOKE_STMT = "revoke all on function public.ops_health_report() from public, anon, authenticated";
const GRANT_STMT = "grant execute on function public.ops_health_report() to service_role";

/** Appended to a non-pass detail so the operator knows where the object names are (they are NOT in the detail). */
const NAMES_POINTER = " · adlar için: docs/ops-heartbeat.md (Anon yüzeyi)";

const PASS_DETAIL =
  "anon/authenticated yetkisi yok: tablo/dizi 0, definer fonksiyon 0, invoker fonksiyon 0 (5 izinli RPC hariç) · auth.users 0";

const COMMENT_PREFIX_136 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136): 16 fixed rows, in this order --";
const COMMENT_PREFIX_145 =
  "Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145): 17 fixed rows, in this order --";
const COMMENT_STATUS_MARK = " status is one of";

// -- character-scan helpers (no regular expression runs over SQL text) ----------

/** Removes `--` comments (to the end of the line, newline kept); quoted strings are copied verbatim. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
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
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" && sql.charAt(i + 1) === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function isTagChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

/** Top-level statements of comment-free SQL; `;` inside strings and dollar-quoted bodies is kept. */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < code.length) {
        if (code.charAt(j) === "'") {
          if (code.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j + 1;
    } else if (ch === "$") {
      let j = i + 1;
      while (j < code.length && isTagChar(code.charAt(j))) j += 1;
      if (code.charAt(j) === "$") {
        const tag = code.slice(i, j + 1);
        const close = code.indexOf(tag, j + 1);
        i = close < 0 ? code.length : close + tag.length;
      } else {
        i += 1;
      }
    } else if (ch === ";") {
      out.push(code.slice(start, i).trim());
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  const tail = code.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Empties the content of every single-quoted string: `'abc'` becomes `''`. */
function blankStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
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
      out += "''";
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function collapse(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** The ROLLBACK paragraph of the header (to the "Additive." line), whitespace-collapsed. */
function rollbackOf(head: string): string {
  const at = head.indexOf("ROLLBACK (");
  expect(at, "ROLLBACK section").toBeGreaterThan(0);
  const end = head.indexOf("Additive. Safe to re-apply", at);
  return collapse(
    head
      .slice(at, end < 0 ? head.length : end)
      .split("\n")
      .map((l) => (l.startsWith("--") ? l.slice(2) : l))
      .join(" "),
  );
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return collapse(stripComments(sql));
}

/** Lower-case identifier-like words of the text, in order. */
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

/** Whether `word` occurs in the text as a whole word (so `grantee` is not `grant`). */
function hasWord(text: string, word: string): boolean {
  return wordsOf(text).includes(word);
}

/** The quoted names of the first `array[ ... ]` at or after `from` (a `]` inside a quoted name, as in `uuid[]`, does not close it). */
function quotedNamesOfArray(text: string, from: number): string[] {
  const open = text.indexOf("array[", from);
  if (open < 0) return [];
  const names: string[] = [];
  let cur: string | null = null;
  for (const ch of text.slice(open + "array[".length)) {
    if (ch === "'") {
      if (cur === null) {
        cur = "";
      } else {
        names.push(cur);
        cur = null;
      }
    } else if (cur !== null) {
      cur += ch;
    } else if (ch === "]") {
      return names;
    }
  }
  return [];
}

/** True when every fragment occurs in the text, each after the previous one. */
function inOrder(text: string, fragments: string[]): boolean {
  let at = 0;
  for (const f of fragments) {
    const found = text.indexOf(f, at);
    if (found < 0) return false;
    at = found + f.length;
  }
  return true;
}

/** The literal check names of a function body, in order (`check_name := 'x';`; the loop's concatenation is not literal). */
function literalCheckNames(body: string): string[] {
  const names: string[] = [];
  const key = "check_name := '";
  let at = body.indexOf(key);
  while (at >= 0) {
    const from = at + key.length;
    const end = body.indexOf("'", from);
    if (body.charAt(end + 1) === ";") names.push(body.slice(from, end));
    at = body.indexOf(key, end);
  }
  return names;
}

/** The joined text of `comment on function public.ops_health_report() is '...' '...';` (adjacent literals). */
function commentText(rawSql: string): string {
  const head = "comment on function public.ops_health_report() is";
  const start = rawSql.indexOf(head);
  expect(start, "comment on function public.ops_health_report()").toBeGreaterThanOrEqual(0);
  let i = start + head.length;
  let out = "";
  for (;;) {
    while (i < rawSql.length && (rawSql.charAt(i) === " " || rawSql.charAt(i) === "\n")) i += 1;
    if (rawSql.charAt(i) !== "'") break;
    i += 1;
    for (;;) {
      const ch = rawSql.charAt(i);
      if (ch === "'") {
        if (rawSql.charAt(i + 1) === "'") {
          out += "'";
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      out += ch;
      i += 1;
    }
  }
  expect(rawSql.charAt(i), "the comment statement ends right after its last literal").toBe(";");
  return out;
}

let sql = "";
let code = "";
let statements: string[] = [];
let sql136 = "";
let rowsOneToSixteen = ""; // A: 136's text from the create line through row 16's `return next;`
let aAt = -1;
let row17Raw = "";
let fnStatement = "";
let fnBody = "";
let row17 = "";

beforeAll(() => {
  expect(existsSync(MIGRATION_145), "145_ops_anon_surface_check.sql must exist").toBe(true);
  sql = readFileSync(MIGRATION_145, "utf8");
  code = stripComments(sql);
  statements = splitStatements(code);
  sql136 = readFileSync(MIGRATION_136, "utf8");

  const from136 = sql136.indexOf(CREATE_LINE);
  const end136 = sql136.indexOf(FN_END, from136);
  expect(from136).toBeGreaterThan(0);
  expect(end136).toBeGreaterThan(from136);
  rowsOneToSixteen = sql136.slice(from136, end136);

  aAt = sql.indexOf(rowsOneToSixteen);
  const rowStart = aAt + rowsOneToSixteen.length;
  const rowEnd = sql.indexOf(FN_END, rowStart);
  row17Raw = aAt < 0 || rowEnd < 0 ? "" : sql.slice(rowStart, rowEnd);
  row17 = norm(row17Raw);

  fnStatement = statements.find((s) => s.startsWith(CREATE_LINE)) ?? "";
  const open = fnStatement.indexOf("$fn$");
  const close = fnStatement.lastIndexOf("$fn$");
  fnBody = open >= 0 && close > open ? fnStatement.slice(open + "$fn$".length, close) : "";
});

describe("145 helpers (the scans are not vacuous)", () => {
  it("stripComments drops -- outside strings and keeps it inside them", () => {
    expect(stripComments("a -- c\nb")).toBe("a \nb");
    expect(stripComments("select '-- not a comment'; -- real\nx")).toBe("select '-- not a comment'; \nx");
    expect(stripComments("select 'it''s -- text'; -- gone")).toBe("select 'it''s -- text'; ");
    expect(stripComments("-- only a comment")).toBe("");
  });

  it("splitStatements keeps ; inside strings and dollar-quoted bodies", () => {
    expect(splitStatements("a; b 'x;y'; c $f$ d; e $f$; g")).toEqual(["a", "b 'x;y'", "c $f$ d; e $f$", "g"]);
    expect(splitStatements("begin;\ncommit;\n")).toEqual(["begin", "commit"]);
  });

  it("blankStrings empties literals, hasWord matches whole words only, quotedNamesOfArray reads the names", () => {
    expect(blankStrings("a 'UPDATE it''s' b 'x'")).toBe("a '' b ''");
    expect(hasWord("select a.grantee from t", "grant")).toBe(false);
    expect(hasWord("grant select on t", "grant")).toBe(true);
    expect(hasWord("x;grant(", "grant")).toBe(true);
    expect(quotedNamesOfArray("x <> all (array['a', 'b_c'] ) 'z'", 0)).toEqual(["a", "b_c"]);
    expect(quotedNamesOfArray("no list here", 0)).toEqual([]);
    expect(quotedNamesOfArray("<> all (array['f(uuid[])', 'g()']) and 'z'", 0)).toEqual(["f(uuid[])", "g()"]);
    expect(quotedNamesOfArray("array['unterminated'", 0)).toEqual([]);
  });

  it("inOrder requires the fragments in sequence", () => {
    expect(inOrder("a b c", ["a", "c"])).toBe(true);
    expect(inOrder("a b c", ["c", "a"])).toBe(false);
    expect(inOrder("a b c", ["a", "d"])).toBe(false);
  });
});

describe("145 ledger, structure and header", () => {
  it("is one transaction: the body starts with begin; and ends with notify, the ledger insert and commit;", () => {
    const firstCodeLine = code.split("\n").find((l) => l.trim() !== "");
    expect(firstCodeLine?.trim()).toBe("begin;");
    expect(statements[0]).toBe("begin");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(statements.filter((s) => s === "begin")).toHaveLength(1);
    expect(statements.filter((s) => s === "commit")).toHaveLength(1);
  });

  it("ends with notify pgrst, then ('145', '145_ops_anon_surface_check') in the 095 pattern, then commit", () => {
    expect(code).toMatch(
      /notify\s+pgrst\s*,\s*'reload schema'\s*;\s*insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'145'\s*,\s*'145_ops_anon_surface_check'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
    expect(statements.filter((s) => s.startsWith("insert into"))).toHaveLength(1);
  });

  it("is exactly eight statements: begin, the function, its comment, revoke, grant, notify, ledger insert, commit", () => {
    expect(statements).toHaveLength(8);
    const starts = [
      "begin",
      CREATE_LINE,
      "comment on function public.ops_health_report() is",
      REVOKE_STMT,
      GRANT_STMT,
      "notify pgrst, 'reload schema'",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ];
    starts.forEach((start, i) => {
      expect(collapse(statements[i] ?? "").startsWith(start), `statement ${i}: ${start}`).toBe(true);
    });
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(sql).toContain("STEP 0");
    expect(code).not.toContain("STEP 0");
  });

  it("the header documents WHY (h19-security-1), STEP 0 (prod fingerprint and counts), both dry runs, deploy, verify, rollback and the founder Auth step", () => {
    const head = sql.slice(0, sql.search(/^begin;/m));
    expect(head.length).toBeGreaterThan(2000);
    for (const section of ["WHY", "WHAT CHANGES", "STEP 0", "DRY RUNS (×2)", "DEPLOY", "VERIFY", "ROLLBACK", "FOUNDER STEP"]) {
      expect(head, section).toContain(section);
    }
    expect(head).toMatch(/safe to re-apply/i);
    // the evidence (h19-security-1)
    for (const word of ["h19-security-1", "signup", "auth.users", "USING(true)", "supabase_admin", "dashboard", "tests/guards/anon-surface.test.ts"]) {
      expect(head, word).toContain(word);
    }
    // Step 0: version free; the deployed function is 136's by md5/length/flags
    expect(head).toMatch(/Version 145 is free/i);
    expect(head).toContain("a2b0b84c193022c78547beb0296e5f0c");
    expect(head).toContain("25,536");
    expect(head).toContain("{postgres=X/postgres,service_role=X/postgres}");
    // Step 0: the row's own query, run against production, and its cost
    expect(head).toMatch(/explain \(analyze\)/i);
    expect(head).toMatch(/expected status.{0,40}pass/is);
    // dry runs
    expect(head).toContain("pg-av-fix");
    expect(head).toContain("55497");
    expect(head).toContain("INSERT 0 1");
    expect(head).toContain("INSERT 0 0");
    expect(head).toMatch(/17 rows/);
    // rollback re-runs ONLY 136's ops_health_report() section, then reloads the schema cache and removes the ledger row
    expect(head).toContain("136_ops_heartbeat_app_side.sql");
    expect(head).toMatch(/delete from supabase_migrations\.schema_migrations where version = '145'/);
    expect(rollbackOf(head)).toContain("ONLY 136's ops_health_report() section");
    expect(rollbackOf(head)).toContain("notify pgrst, 'reload schema'");
    // the founder step
    expect(head).toContain("Allow new users to sign up");
    expect(head).toContain("disable_signup");
  });

  it("runs in the order function, comment, revoke, grant, notify, ledger", () => {
    const at = (needle: string) => code.indexOf(needle);
    const fn = at(CREATE_LINE);
    const comment = at("comment on function public.ops_health_report()");
    const revoke = at(REVOKE_STMT);
    const grant = at(GRANT_STMT);
    const notify = at("notify pgrst");
    const ledger = at("insert into supabase_migrations.schema_migrations");
    expect(fn).toBeGreaterThan(at("begin;"));
    expect(comment).toBeGreaterThan(fn);
    expect(revoke).toBeGreaterThan(comment);
    expect(grant).toBeGreaterThan(revoke);
    expect(notify).toBeGreaterThan(grant);
    expect(ledger).toBeGreaterThan(notify);
  });
});

describe("145 rollback re-runs only 136's ops_health_report() section (never the whole file)", () => {
  /** 136's section 3: from the create line through the grant that closes it. */
  const section136 = (): string => {
    const text136 = readFileSync(MIGRATION_136, "utf8");
    const from = text136.indexOf(CREATE_LINE);
    const grantAt = text136.indexOf(GRANT_STMT + ";", from);
    expect(from).toBeGreaterThan(0);
    expect(grantAt).toBeGreaterThan(from);
    return text136.slice(from, grantAt + GRANT_STMT.length + 1);
  };

  it("that section creates exactly one function, ops_health_report(), and neither re-creates ops_db_size_limits() nor touches pg_cron", () => {
    const section = section136();
    expect([...stripComments(section).matchAll(/\bcreate\s+or\s+replace\s+function\s+([a-z_.]+)\s*\(/gi)].map((m) => m[1])).toEqual([
      "public.ops_health_report",
    ]);
    const words = wordsOf(blankStrings(stripComments(section)));
    expect(words).not.toContain("schedule");
    expect(words).not.toContain("unschedule");
    expect(section).not.toContain("select 7000::numeric, 7600::numeric");
    expect(section.endsWith(GRANT_STMT + ";")).toBe(true);
  });

  it("whereas the whole of 136 does re-create ops_db_size_limits() with the defaults and re-schedules the prune job (why the header says NOT to re-apply it whole)", () => {
    const whole = readFileSync(MIGRATION_136, "utf8");
    expect(whole).toContain("create or replace function public.ops_db_size_limits()");
    expect(whole).toContain("select 7000::numeric, 7600::numeric");
    expect(whole).toContain("cron.schedule('ops-cron-route-runs-prune'");
  });

  it("the header's rollback names the section, forbids the whole-file re-apply and says why", () => {
    const head = sql.slice(0, sql.search(/^begin;/m));
    const rollback = rollbackOf(head);
    expect(rollback).toContain("ONLY 136's ops_health_report() section");
    expect(rollback).toContain("create or replace function public.ops_health_report()");
    expect(rollback).toContain("grant execute on function public.ops_health_report() to service_role;");
    expect(rollback).toContain("Do NOT re-apply 136_ops_heartbeat_app_side.sql as a whole file");
    expect(rollback).toContain("ops_db_size_limits()");
    expect(rollback).toContain("7000 / 7600");
    expect(rollback).toContain("ops-cron-route-runs-prune");
    expect(rollback).toContain("delete from supabase_migrations.schema_migrations where version = '145'");
    // the old instruction is gone
    expect(rollback).not.toContain("re-apply 136_ops_heartbeat_app_side.sql whole");
  });

  it("docs/migration-guide.md gives the same rollback", () => {
    const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
    const at = guide.indexOf("## 145 ");
    expect(at, "docs/migration-guide.md has a 145 section").toBeGreaterThan(0);
    const next = guide.indexOf("\n## ", at + 1);
    const section = collapse(guide.slice(at, next < 0 ? guide.length : next));
    const rollbackAt = section.indexOf("**Rollback**");
    expect(rollbackAt).toBeGreaterThan(0);
    const rb = section.slice(rollbackAt);
    expect(rb).toContain("ONLY 136's `ops_health_report()` section");
    expect(rb).toContain("create or replace function public.ops_health_report()");
    expect(rb).toContain("grant execute on function public.ops_health_report() to service_role;");
    expect(rb).toContain("notify pgrst, 'reload schema';");
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '145';");
    expect(rb).toContain("Do NOT re-apply `136_ops_heartbeat_app_side.sql` as a whole file");
    expect(rb).toContain("ops_db_size_limits()");
    expect(rb).not.toContain("whole (idempotent");
  });
});

describe("145 detail is published: counts only, names live in the operator runbook", () => {
  it("docs/ops-heartbeat.md says the heartbeat output is public, keeps the name-listing diagnostic, and describes the detail as counts only", () => {
    const doc = readFileSync(DOC_OPS_HEARTBEAT, "utf8");
    const at = doc.indexOf("## Anon yüzeyi (migration 145");
    expect(at).toBeGreaterThan(0);
    const next = doc.indexOf("\n## ", at + 1);
    const section = doc.slice(at, next < 0 ? doc.length : next);
    // why: the public repository's Actions log and step summary
    expect(section).toContain("public");
    expect(section).toContain("GITHUB_STEP_SUMMARY");
    expect(section).toContain("counts only");
    // the diagnostic that lists the names runs with service role / in the SQL editor, not in the report
    expect(section).toContain("has_table_privilege");
    expect(section).toContain("has_sequence_privilege");
    expect(section).toContain("has_function_privilege");
    expect(section).toContain("oidvectortypes");
    expect(section).toContain("service_role");
    // the table row no longer promises names in the detail
    const row = doc.slice(doc.indexOf("| 17 | `anon_surface`"), doc.indexOf("\n", doc.indexOf("| 17 | `anon_surface`")));
    expect(row).toContain("counts only");
    expect(row).not.toContain("counts and names only");
    expect(row).not.toContain("` · tablo/dizi: a, b`");
    expect(row).toContain("adlar için: docs/ops-heartbeat.md (Anon yüzeyi)");
  });
});

describe("145 rows 1-16 are 136's, byte for byte", () => {
  it("136's text from the create line through row 16's `return next;` is not vacuous", () => {
    expect(rowsOneToSixteen.startsWith(CREATE_LINE)).toBe(true);
    expect(rowsOneToSixteen.endsWith("  return next;")).toBe(true);
    expect(rowsOneToSixteen).toContain("-- 14. ingest_gaps (migration 122).");
    expect(rowsOneToSixteen).toContain("-- 15. cron_route_failures_30m (migration 136).");
    expect(rowsOneToSixteen).toContain("-- 16. db_size_mb (migration 136).");
    expect(rowsOneToSixteen.length).toBeGreaterThan(20000);
  });

  it("145 contains that text exactly once, followed by the row-17 block and then `  return;\\nend\\n$fn$;`", () => {
    expect(aAt, "145 holds 136's rows 1-16 verbatim").toBeGreaterThan(0);
    expect(sql.indexOf(rowsOneToSixteen, aAt + 1)).toBe(-1);
    // the create line is executable exactly once (the header's ROLLBACK paragraph quotes it too, in a comment)
    expect(code.indexOf(CREATE_LINE)).toBeGreaterThanOrEqual(0);
    expect(code.indexOf(CREATE_LINE, code.indexOf(CREATE_LINE) + 1)).toBe(-1);
    expect(sql.lastIndexOf(CREATE_LINE)).toBe(aAt);
    expect(sql.slice(aAt + rowsOneToSixteen.length).startsWith("\n\n  " + MARKER_17)).toBe(true);
    expect(row17Raw.endsWith("  return next;")).toBe(true);
    expect(sql.slice(aAt + rowsOneToSixteen.length + row17Raw.length).startsWith(FN_END)).toBe(true);
    // the function ends there: only the comment, revoke and grant follow
    expect(sql.indexOf(FN_END)).toBe(aAt + rowsOneToSixteen.length + row17Raw.length);
  });

  it("the literal check names are 136's sixteen followed by anon_surface, in that order", () => {
    expect(literalCheckNames(fnBody)).toEqual(ROW_NAMES_17.filter((n) => !n.startsWith("ingest_fresh_")));
    const names136 = literalCheckNames(rowsOneToSixteen);
    expect(names136).toHaveLength(16 - 3); // 16 rows, the three per-zone freshness rows are built in a loop
    expect(literalCheckNames(fnBody)).toEqual([...names136, CHECK_17]);
  });

  it("keeps 136's header (security definer, volatile, search_path = '', returns table) and its declare block", () => {
    const head145 = fnStatement.slice(0, fnStatement.indexOf("$fn$"));
    const head136 = rowsOneToSixteen.slice(0, rowsOneToSixteen.indexOf("$fn$"));
    expect(collapse(head145)).toBe(collapse(head136));
    expect(collapse(head145)).toContain(
      "returns table (check_name text, status text, observed numeric, threshold numeric, detail text) language plpgsql volatile security definer set search_path = ''",
    );
    const declare = (text: string) => collapse(text.slice(text.indexOf("declare"), text.indexOf("\nbegin\n")));
    expect(declare(fnBody)).toBe(declare(rowsOneToSixteen));
    expect(declare(fnBody)).toContain("v_zone text;");
    expect(fnBody.trimStart().startsWith("#variable_conflict use_column")).toBe(true);
  });

  it("the function body has no $fn$ of its own and the file has exactly the opening and the closing $fn$", () => {
    expect(fnBody).not.toContain("$fn$");
    expect(code.split("$fn$")).toHaveLength(3);
  });
});

describe("145 row 17: anon_surface", () => {
  it("is the last check: marker comment first, then the fixed preamble, one `return next;`", () => {
    expect(row17Raw.trimStart().startsWith(MARKER_17)).toBe(true);
    expect(row17.startsWith("check_name := 'anon_surface'; threshold := 1; observed := null; detail := null; begin")).toBe(true);
    expect([...row17.matchAll(/\breturn next;/g)]).toHaveLength(1);
    expect(row17.endsWith("return next;")).toBe(true);
    expect(fnBody.trimEnd().endsWith("return next;\n\n  return;\nend")).toBe(true);
  });

  it("the marker comment names the evidence: signup open, no Supabase Auth use, the USING(true) policies, supabase_admin, and what the guard cannot see", () => {
    const start = row17Raw.indexOf(MARKER_17);
    const comment = row17Raw.slice(start, row17Raw.indexOf("\n", start));
    for (const word of ["signup", "auth.users", "13", "USING", "supabase_admin", "anon-surface.test.ts", "fail", "warn"]) {
      expect(comment.toLowerCase(), word).toContain(word.toLowerCase());
    }
    // the detail is published (public Actions log): counts only, no object names
    for (const word of ["counts only", "public", "Actions", "never object names"]) {
      expect(comment, word).toContain(word);
    }
  });

  it("the roles: a missing anon or authenticated is 'skip' with the Turkish detail, not an error", () => {
    expect(row17).toContain("if pg_catalog.to_regrole('anon') is null or pg_catalog.to_regrole('authenticated') is null then");
    expect(row17).toContain("status := 'skip'; detail := 'anon/authenticated rolü yok';");
  });

  it("relations and sequences: the privileges of both roles over pg_class in public, relkinds r p v m f and S", () => {
    expect(row17).toContain("from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace");
    expect(row17).toContain("n.nspname = 'public'");
    expect(row17).toContain("c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')");
    for (const role of ["anon", "authenticated"]) {
      expect(row17, role).toContain(
        `pg_catalog.has_table_privilege('${role}', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`,
      );
      expect(row17, role).toContain(`pg_catalog.has_sequence_privilege('${role}', c.oid, 'USAGE,SELECT,UPDATE')`);
    }
    // a sequence is asked with has_sequence_privilege only, a table-like relation with has_table_privilege only
    expect(row17).toContain("case when c.relkind = 'S' then pg_catalog.has_sequence_privilege('anon'");
    expect(row17).toContain("else pg_catalog.has_table_privilege('anon'");
  });

  it("any ACL entry for either role counts, which catches PG17 MAINTAIN (PG15 cannot name it)", () => {
    expect(row17).toContain("from pg_catalog.aclexplode(c.relacl) a");
    expect(row17).toContain("a.grantee in (pg_catalog.to_regrole('anon')::oid, pg_catalog.to_regrole('authenticated')::oid)");
    expect(row17).not.toMatch(/\bmaintain\b/i);
  });

  it("functions: SECURITY DEFINER or invoker functions of public that anon or authenticated can execute, minus triggers, extension members and the allowlist", () => {
    expect(row17).toContain("from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace");
    expect(row17).toContain("p.prokind in ('f', 'p')");
    expect(row17).toContain(
      "p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype, 'pg_catalog.event_trigger'::pg_catalog.regtype)",
    );
    expect(row17).toContain(
      "not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid and d.deptype = 'e')",
    );
    expect(row17).toContain("pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')");
    expect(row17).toContain("pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')");
    // definer and invoker are counted apart, counted only: no name is read into a variable
    expect(row17).toContain("select p.prosecdef as definer from pg_catalog.pg_proc p");
    expect(row17).toContain("count(*) filter (where f.definer)");
    expect(row17).toContain("count(*) filter (where not f.definer)");
    expect(row17).toContain("into v_total, v_jobs from (");
  });

  it("auth.users: counted (capped at 1000 rows) only when the table exists, no column is read, and a read error cannot hide a privilege finding", () => {
    expect(row17).toContain("if pg_catalog.to_regclass('auth.users') is not null then");
    expect(row17).toContain(
      "execute 'select pg_catalog.count(*)::numeric from (select 1 from auth.users limit 1000) u' into v_zero;",
    );
    // the read is wrapped on its own: failing to read auth.users leaves v_zero null, the status still comes from the privileges
    expect(row17).toContain("exception when others then v_zero := null; end;");
    // exactly three mentions: the to_regclass guard, the dynamic read and the detail label
    expect(row17.split("auth.users")).toHaveLength(4);
    expect(row17).toContain("' · auth.users ' || coalesce(v_zero::text, 'okunamadı')");
  });

  it("status: fail on any table, sequence or definer finding; warn on an invoker finding or a user in auth.users; else pass", () => {
    expect(row17).toContain("observed := v_n + v_total + v_jobs;");
    expect(row17).toContain(
      "status := case when v_n + v_total >= 1 then 'fail' when v_jobs >= 1 or coalesce(v_zero, 0) >= 1 then 'warn' else 'pass' end;",
    );
    for (const s of ["pass", "warn", "fail", "skip", "unknown"]) expect(row17, s).toContain(`'${s}'`);
    expect(row17).toContain("threshold := 1;");
  });

  it("detail: Turkish, COUNTS ONLY (the Actions log and step summary are public), the exact pass wording, a pointer to the docs instead of names, cut at 500 characters", () => {
    expect(
      inOrder(row17, [
        "'anon/authenticated yetkisi yok: '",
        "'tablo/dizi '",
        "', definer fonksiyon '",
        "', invoker fonksiyon '",
        "' (5 izinli RPC hariç)'",
        `'${NAMES_POINTER}'`,
        "' · auth.users '",
      ]),
    ).toBe(true);
    // reassembled with zero counts (observed = 0: no pointer), the fragments read as the pass detail
    const passed =
      "anon/authenticated yetkisi yok: " + "tablo/dizi " + 0 + ", definer fonksiyon " + 0 + ", invoker fonksiyon " + 0 + " (5 izinli RPC hariç)" + " · auth.users " + 0;
    expect(passed).toBe(PASS_DETAIL);
    // the pointer is added only when something was found
    expect(row17).toContain(`case when observed > 0 then '${NAMES_POINTER}' else '' end`);
    // the non-pass prefix must not claim there is no privilege
    expect(row17).toContain("'anon/authenticated yetkisi var: '");
    expect(row17).toContain("1, 500);");
  });

  it("detail never carries an object name: no name list, no name aggregate, no name variable in the detail expression", () => {
    expect(row17).not.toContain("' · tablo/dizi: '");
    expect(row17).not.toContain("' · fonksiyon: '");
    expect(row17).not.toContain("array_agg");
    expect(row17).not.toContain("array_to_string");
    expect(row17).not.toContain("pg_get_function_identity_arguments");
    expect(wordsOf(row17)).not.toContain("relname");
    // the whole detail assignment reads counts only
    const at = row17.indexOf("detail := substr(");
    const end = row17.indexOf("1, 500);", at);
    expect(at).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(at);
    const used = new Set(wordsOf(blankStrings(row17.slice(at, end))).filter((w) => w.startsWith("v_")));
    expect([...used].sort()).toEqual(["v_jobs", "v_n", "v_total", "v_zero"]);
    // and v_text / v_zone, which held the names, are not used by row 17 at all
    expect(wordsOf(row17)).not.toContain("v_text");
    expect(wordsOf(row17)).not.toContain("v_zone");
  });

  it("the count in '(5 izinli RPC hariç)' is the size of the allowlist", () => {
    expect(ALLOWED_RPCS).toHaveLength(5);
    expect(row17).toContain(`(${ALLOWED_RPCS.length} izinli RPC hariç)`);
  });

  it("answers 'unknown' with the first 200 characters of the error if the query fails", () => {
    expect(row17.endsWith("exception when others then status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200); end; return next;")).toBe(true);
  });

  it("uses only declared variables (v_n, v_total, v_jobs, v_zero): the declare block is 136's", () => {
    const used = wordsOf(row17).filter((w) => w.startsWith("v_"));
    for (const v of new Set(used)) {
      expect(["v_n", "v_total", "v_jobs", "v_zero"], v).toContain(v);
    }
    for (const v of ["v_n", "v_total", "v_jobs", "v_zero"]) expect(used, v).toContain(v);
  });

  it("qualifies every catalogue function with pg_catalog and only reads", () => {
    for (const fn of [
      "count",
      "to_regrole",
      "to_regclass",
      "has_table_privilege",
      "has_sequence_privilege",
      "has_function_privilege",
      "aclexplode",
      "oidvectortypes",
    ]) {
      const bare = new RegExp(`(?<![.\\w])${fn}\\s*\\(`, "g");
      expect([...row17.matchAll(bare)], `bare ${fn}(`).toEqual([]);
    }
    const bareWords = wordsOf(blankStrings(row17));
    for (const forbidden of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "grant", "revoke", "vacuum", "analyze", "perform"]) {
      expect(bareWords, forbidden).not.toContain(forbidden);
    }
    expect(bareWords.filter((w) => w === "execute")).toHaveLength(1);
  });

  it("the word 'grant' never appears in the function body, comments included (the anon-surface guard scans bodies for it); the aclexplode column is 'grantee'", () => {
    const rawBodyStart = sql.indexOf("$fn$", aAt) + "$fn$".length;
    const rawBody = sql.slice(rawBodyStart, sql.indexOf(FN_END, aAt));
    expect(rawBody.length).toBeGreaterThan(rowsOneToSixteen.length - 400);
    expect(hasWord(rawBody, "grant")).toBe(false);
    expect(hasWord(rawBody, "grants")).toBe(false);
    expect(hasWord(fnBody, "grant")).toBe(false);
    expect(hasWord(row17Raw, "grantee")).toBe(true);
  });
});

describe("145 allowlist parity", () => {
  /** The identity expression the check compares: name plus argument types, exactly as oidvectortypes prints them. */
  const IDENTITY_EXPR = "p.proname::text || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' <> all (";

  it("the array after the identity expression lists exactly ALLOWED_RPC_IDENTITIES (tests/_helpers/anon-rpc-allowlist.ts), in order", () => {
    const at = row17.indexOf(IDENTITY_EXPR);
    expect(at, "the exclusion compares name + argument types").toBeGreaterThan(0);
    expect(quotedNamesOfArray(row17, at)).toEqual([...ALLOWED_RPC_IDENTITIES]);
    // the array sits inside the all(...) call and there is exactly one such exclusion
    expect(row17.indexOf("<> all (", at + IDENTITY_EXPR.length)).toBe(-1);
    expect(row17.indexOf(IDENTITY_EXPR, at + 1)).toBe(-1);
  });

  it("the allowlist is by full identity, never by bare name (an anon-executable overload of an allowlisted name must be counted)", () => {
    expect(row17).not.toContain("p.proname <> all (");
    expect(row17).not.toContain("proname <> all");
    // every entry carries its argument list; the names alone equal ALLOWED_RPCS
    const entries = quotedNamesOfArray(row17, row17.indexOf(IDENTITY_EXPR));
    expect(entries.map((e) => e.slice(0, e.indexOf("(")))).toEqual([...ALLOWED_RPCS]);
    for (const e of entries) expect(e.endsWith(")"), e).toBe(true);
    // the five signatures are the ones production has (one each: uuid[], none, none, text, uuid[])
    expect(entries).toEqual([
      "saved_clusters(uuid[])",
      "merged_cluster_map()",
      "source_slugs()",
      "source_slug_exists(text)",
      "saved_clusters_v2(uuid[])",
    ]);
  });
});

describe("145 additive shape and privileges", () => {
  it("creates exactly one function and nothing else; nothing altered, dropped, truncated or written except the ledger row", () => {
    expect([...code.matchAll(/\bcreate\s+or\s+replace\s+function\s+([a-z_.]+)\s*\(/gi)].map((m) => m[1])).toEqual([
      "public.ops_health_report",
    ]);
    const outside = statements.filter((s) => !s.startsWith(CREATE_LINE));
    for (const s of outside) {
      const w = wordsOf(blankStrings(s));
      for (const forbidden of ["create", "alter", "drop", "truncate", "update", "delete", "policy", "default", "privileges"]) {
        expect(w, `${forbidden} in: ${s.slice(0, 60)}`).not.toContain(forbidden);
      }
    }
    expect(outside.filter((s) => s.startsWith("insert"))).toHaveLength(1);
    const words = wordsOf(blankStrings(code));
    for (const forbidden of ["policy", "alter", "drop", "truncate", "concurrently"]) expect(words, forbidden).not.toContain(forbidden);
  });

  it("the only grant is `grant execute ... to service_role`; the only revoke is 136's, from public, anon and authenticated", () => {
    const grants = statements.filter((s) => hasWord(blankStrings(s), "grant") && !s.startsWith(CREATE_LINE));
    expect(grants.map(collapse)).toEqual([GRANT_STMT]);
    const revokes = statements.filter((s) => hasWord(blankStrings(s), "revoke") && !s.startsWith(CREATE_LINE));
    expect(revokes.map(collapse)).toEqual([REVOKE_STMT]);
    // no other grant or revoke anywhere, bodies and comment text excluded from this count
    expect(wordsOf(blankStrings(code)).filter((w) => w === "grant")).toHaveLength(1);
    expect(wordsOf(blankStrings(code)).filter((w) => w === "revoke")).toHaveLength(1);
  });

  it("stays SECURITY DEFINER with search_path = '' and volatile plpgsql", () => {
    const h = collapse(fnStatement.slice(0, fnStatement.indexOf("$fn$")));
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = ''");
    expect(h).toContain("volatile");
    expect(h).toContain("language plpgsql");
  });
});

describe("145 comment on function", () => {
  let c136 = "";
  let c145 = "";
  let middle136 = "";
  let tail136 = "";

  beforeAll(() => {
    c136 = commentText(sql136);
    c145 = commentText(sql);
    expect(c136.startsWith(COMMENT_PREFIX_136)).toBe(true);
    const mark = c136.indexOf(COMMENT_STATUS_MARK);
    expect(mark).toBeGreaterThan(0);
    // 136's description list, without the final full stop that closes db_size_mb's description
    middle136 = c136.slice(COMMENT_PREFIX_136.length, mark - 1);
    tail136 = c136.slice(mark);
    expect(c136.charAt(mark - 1)).toBe(".");
  });

  it("is 136's text with the migration list ending 136, 145 and `17 fixed rows`", () => {
    expect(c145.startsWith(COMMENT_PREFIX_145)).toBe(true);
    expect(c145).not.toContain("16 fixed rows");
  });

  it("adds the anon_surface description right before ' status is one of', after db_size_mb's, which now ends with a comma", () => {
    expect(c145.slice(COMMENT_PREFIX_145.length).startsWith(middle136 + ", anon_surface (")).toBe(true);
    expect(c145.endsWith(tail136)).toBe(true);
    const description = c145.slice(COMMENT_PREFIX_145.length + middle136.length + 1, c145.length - tail136.length);
    expect(description.startsWith(" anon_surface (")).toBe(true);
    expect(description.endsWith(").")).toBe(true);
    for (const word of ["anon", "authenticated", "table", "sequence", "SECURITY DEFINER", "invoker", "auth.users", "fail", "warn", "skip", "full signature"]) {
      expect(description, word).toContain(word);
    }
    // counts only: the heartbeat output is public, so the comment must not promise names
    expect(description).toContain("counts only, never object names or user data");
    expect(description).not.toContain("object names only");
    expect(description).not.toContain("first 10 of each");
    // the five allowlisted RPCs are named, so the comment cannot drift from the exclusion
    for (const name of ALLOWED_RPCS) expect(description, name).toContain(name);
  });

  it("still says service_role only and points at docs/ops-heartbeat.md", () => {
    expect(c145).toContain("service_role only");
    expect(c145).toContain("docs/ops-heartbeat.md");
    expect(c145).toContain("status is one of pass|warn|fail|unknown|skip");
  });
});
