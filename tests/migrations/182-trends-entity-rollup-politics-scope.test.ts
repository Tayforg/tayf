import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  POLITICS_CATEGORIES,
  isPoliticsMember,
} from "../../supabase/functions/_shared/cluster/politics-admission";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 182 (h90-trends-1): "Yükselen Konular"
// on /trends counted headlines from every feed category, but its links go to
// /gundem hubs that list only politics clusters. "BDDK 8 Kasım: 36 haber" was
// 35 genel / ekonomi / teknoloji headlines the clusterer never admits
// (isPoliticsMember, politics-admission.ts: politika and son_dakika, or a
// non-null politics_admitted_at) plus one politika headline, so the hub it links
// to could not show them. 182 is a function-only `create or replace` of 163's
// refresh function: 163's body plus the same politics scope in `day_articles`.
//
// Style mirrors tests/migrations/163-trends-entity-rollup-guards.test.ts:
// comments are stripped before every code assertion so prose can never satisfy a
// guard. Three layers:
//   1. the contract (signature, security, grants, no data writes, no backfill);
//   2. 182's function body = 163's body once the marked politics-scope block and
//      the two extra inner columns are removed (and 163's body is the production
//      body: the fingerprint of the header);
//   3. parity of the predicate with POLITICS_CATEGORIES / isPoliticsMember.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "182_trends_entity_rollup_politics_scope.sql";
const PREVIOUS = "163_trends_entity_rollup_guards.sql";
const GUIDE = resolve(REPO_ROOT, "docs", "migration-guide.md");
const FN = "public.trends_daily_entity_counts_ist_refresh";

// What production holds for the function before 182 (read-only, 2026-11-09):
// md5(prosrc) and length(prosrc). It equals 163's body, byte for byte.
const PROD_163_MD5 = "dc1e1d4780b3b8d2e9c0a4ac8c64caf8";
const PROD_163_LENGTH = 7590;

const SCOPE_BEGIN = "           -- 182 politics scope begin\n";
const SCOPE_END = "           -- 182 politics scope end\n";
const X_COLUMNS = ", x.category, x.politics_admitted_at";
const Y_COLUMNS = ", y.category, y.politics_admitted_at";

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text pg_proc.prosrc holds: everything between `as $fn$` and `$fn$;`. */
function fnBody(sql: string): string {
  const m = /\bas \$fn\$([\s\S]*?)\$fn\$;/.exec(sql);
  expect(m, "a $fn$ function body").not.toBeNull();
  return m![1]!;
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/** 182's body with the marked scope block and the two extra inner columns removed. */
function withoutPoliticsScope(body: string): string {
  const begin = body.indexOf(SCOPE_BEGIN);
  const end = body.indexOf(SCOPE_END);
  expect(begin, "scope begin marker").toBeGreaterThan(-1);
  expect(end, "scope end marker").toBeGreaterThan(begin);
  return (body.slice(0, begin) + body.slice(end + SCOPE_END.length))
    .replace(X_COLUMNS, "")
    .replace(Y_COLUMNS, "");
}

/** The `emap` or `guard_map` CTE of a function body, from its name to the next CTE. */
function cteSpan(body: string, name: "emap" | "guard_map"): string {
  const re =
    name === "emap"
      ? /with emap\(token, entity\) as \(values[\s\S]*?\),\s*day_articles as/
      : /guard_map\(entity, excl, trusted\) as \(values[\s\S]*?\),\s*guarded as/;
  const m = re.exec(body);
  expect(m, `${name} span`).not.toBeNull();
  return m![0];
}

describe("migration 182_trends_entity_rollup_politics_scope.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let body = "";
  let prev = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = readFileSync(path, "utf8");
    code = stripComments(sql);
    body = fnBody(sql);
    prev = fnBody(readFileSync(resolve(MIGRATIONS_DIR, PREVIOUS), "utf8"));
  });

  // -- hygiene ---------------------------------------------------------------

  it("contains the ledger insert for '182'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'182'\s*,\s*'182_trends_entity_rollup_politics_scope'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code.trim()).toMatch(/^begin\s*;/i);
    expect(code.trim()).toMatch(/\bcommit\s*;$/i);
    expect((code.match(/^\s*begin\s*;/gim) ?? []).length).toBe(1);
    expect((code.match(/^\s*commit\s*;/gim) ?? []).length).toBe(1);
  });

  it("is function-only: it creates, drops and alters nothing but the one function", () => {
    expect(code).not.toMatch(/\bcreate\s+(table|index|view|trigger|policy|schema|extension)\b/i);
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/\balter\s+(table|function|role|schema)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bcron\.(alter_job|schedule|unschedule)\b/i);
    expect((code.match(/\bcreate\s+or\s+replace\s+function\b/gi) ?? []).length).toBe(1);
  });

  it("does not mention the zone name, so zone-parity.test.ts needs no registration", () => {
    expect(sql).not.toContain("iktidar");
  });

  it("documents the fingerprint, why, the replay, deploy order, rollback and that nothing is backfilled", () => {
    const header = sql.slice(0, sql.search(/^begin\s*;/im));
    expect(header).toMatch(/\bWHY\b/);
    expect(header).toMatch(/FINGERPRINT/);
    expect(header).toContain(PROD_163_MD5);
    expect(header).toContain(String(PROD_163_LENGTH));
    expect(header).toContain(md5(body));
    expect(header).toContain(String(body.length));
    expect(header).toMatch(/REPLAY/);
    expect(header).toMatch(/DEPLOY ORDER/);
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toMatch(/NO BACKFILL/);
  });

  it("says what the week after applying looks like: old rows keep the all-category basis, ratios are deflated, nothing rises falsely", () => {
    const header = sql.slice(0, sql.search(/^begin\s*;/im));
    const noBackfill = header.slice(header.indexOf("NO BACKFILL"));
    expect(noBackfill).toMatch(/all[- ]category/i);
    expect(noBackfill).toMatch(/8 days/);
    expect(noBackfill).toMatch(/deflated/i);
    expect(noBackfill).toMatch(/none rises? falsely|never (?:rises|invented)|no false/i);
  });

  // -- the function, signature and security as 163 -----------------------------------

  it("replaces the function with the identical signature, SECURITY DEFINER, search_path '' and custom plans", () => {
    expect(code).toMatch(
      new RegExp(
        `create\\s+or\\s+replace\\s+function\\s+${esc(FN)}\\s*\\(\\s*p_days\\s+integer\\s+default\\s+2\\s*\\)\\s*returns\\s+integer\\s+language\\s+plpgsql\\s+security\\s+definer\\s+set\\s+search_path\\s*=\\s*''\\s+set\\s+plan_cache_mode\\s*=\\s*force_custom_plan\\s+as\\s+\\$fn\\$`,
        "i",
      ),
    );
  });

  it("keeps the advisory lock and the never-raise exception handler of 163", () => {
    expect(body).toContain(
      "pg_catalog.hashtext('trends_daily_entity_counts_ist_refresh')::bigint",
    );
    expect(body).toContain("pg_try_advisory_xact_lock");
    expect(body).toMatch(/exception when others or query_canceled then/);
    expect(body).toMatch(/return -1;/);
  });

  it("revokes execute from public/anon/authenticated and grants only service_role", () => {
    expect(code).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+${esc(FN)}\\s*\\(\\s*integer\\s*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`,
        "i",
      ),
    );
    expect(code).toMatch(
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+${esc(FN)}\\s*\\(\\s*integer\\s*\\)\\s+to\\s+service_role\\s*;`,
        "i",
      ),
    );
    for (const stmt of code.split(";")) {
      if (/^\s*grant\b/i.test(stmt)) {
        expect((stmt.split(/\sto\s/i)[1] ?? "").trim(), stmt).toBe("service_role");
      }
    }
    expect(code).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });

  it("restates the function comment and mentions 182", () => {
    expect(code).toMatch(
      new RegExp(`comment\\s+on\\s+function\\s+${esc(FN)}\\s*\\(\\s*integer\\s*\\)\\s+is\\s+'`, "i"),
    );
    const comment = /comment\s+on\s+function[\s\S]*?'\s*;/i.exec(code)![0];
    expect(comment).toContain("182");
    expect(comment).toContain("163");
  });

  // -- no backfill ----------------------------------------------------------------

  it("backfills nothing: no call of the function, no DO block, no direct write to the rollup", () => {
    // The only `insert into` of the rollup is the upsert inside the function body.
    expect((code.match(/\binsert\s+into\s+public\.trends_daily_entity_counts_ist_rollup\b/gi) ?? []).length).toBe(1);
    expect(code.indexOf("insert into public.trends_daily_entity_counts_ist_rollup")).toBeGreaterThan(
      code.indexOf("$fn$"),
    );
    expect(code.lastIndexOf("insert into public.trends_daily_entity_counts_ist_rollup")).toBeLessThan(
      code.lastIndexOf("$fn$"),
    );
    expect(code).not.toMatch(/\bdo\s+\$/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/(?:select|perform)\s+public\.trends_daily_entity_counts_ist_refresh/i);
    expect(code).not.toMatch(/trends_daily_entity_counts_ist_refresh\s*\(\s*\d+\s*\)/i);
  });

  // -- the body is 163's body plus the politics scope -----------------------------------

  it("163's function body is the production body (md5 and length of prosrc)", () => {
    expect(md5(prev)).toBe(PROD_163_MD5);
    expect(prev.length).toBe(PROD_163_LENGTH);
  });

  it("182's body equals 163's body once the politics-scope predicate and the two extra inner columns are removed", () => {
    expect(withoutPoliticsScope(body)).toBe(prev);
  });

  it("emap and guard_map are unchanged from 163", () => {
    expect(cteSpan(body, "emap")).toBe(cteSpan(prev, "emap"));
    expect(cteSpan(body, "guard_map")).toBe(cteSpan(prev, "guard_map"));
    // and the 163 guard block itself is still there, once
    expect(body.split("      -- 163 guards begin\n")).toHaveLength(2);
    expect(body.split("      -- 163 guards end\n")).toHaveLength(2);
  });

  it("the scope block is one contiguous span, once, inside day_articles' where clause", () => {
    expect(body.split(SCOPE_BEGIN)).toHaveLength(2);
    expect(body.split(SCOPE_END)).toHaveLength(2);
    const dayAt = body.search(/\bday_articles\s+as\s*\(/);
    const beginAt = body.indexOf(SCOPE_BEGIN);
    const endAt = body.indexOf(SCOPE_END);
    const toksAt = body.search(/\btoks\s+as\s*\(/);
    const kindAt = body.search(/and s\.kind in \('outlet', 'wire'\)/);
    const titleAt = body.search(/and a\.title is not null/);
    expect(dayAt).toBeGreaterThan(-1);
    expect(beginAt).toBeGreaterThan(dayAt);
    expect(endAt).toBeGreaterThan(beginAt);
    expect(toksAt).toBeGreaterThan(endAt);
    // between the kind filter and the title filter: part of the same where clause
    expect(kindAt).toBeGreaterThan(-1);
    expect(beginAt).toBeGreaterThan(kindAt);
    expect(titleAt).toBeGreaterThan(endAt);
  });

  it("both inner index-range selects also project category and politics_admitted_at (and only those two are new)", () => {
    expect(body).toContain(
      `select x.id, x.title, x.source_id, x.published_at, x.created_at${X_COLUMNS}\n`,
    );
    expect(body).toContain(
      `select y.id, y.title, y.source_id, y.published_at, y.created_at${Y_COLUMNS}\n`,
    );
    expect(body.split(X_COLUMNS)).toHaveLength(2);
    expect(body.split(Y_COLUMNS)).toHaveLength(2);
  });

  // -- parity with isPoliticsMember --------------------------------------------------------

  /** The one predicate line inside the marked block. */
  function predicate(): string {
    const begin = body.indexOf(SCOPE_BEGIN);
    const end = body.indexOf(SCOPE_END);
    const block = stripComments(body.slice(begin, end));
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    expect(lines, "exactly one code line in the scope block").toHaveLength(1);
    return lines[0]!.trim();
  }

  it("the predicate is `a.category in (<POLITICS_CATEGORIES>) or a.politics_admitted_at is not null`", () => {
    const m = /^and \(a\.category in \(([^)]*)\) or a\.politics_admitted_at is not null\)$/.exec(
      predicate(),
    );
    expect(m, "predicate shape").not.toBeNull();
    const cats = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((c) => c[1]!);
    expect(m![1]!.replace(/'[a-z_]+'/g, "").replace(/[\s,]/g, "")).toBe("");
    expect(cats).toEqual([...POLITICS_CATEGORIES]);
  });

  it("the predicate keeps what isPoliticsMember keeps, and only that", () => {
    // The SQL under three-valued logic: a null category makes `category in (...)`
    // null, and `null or true` is true, `null or false` is null (the row is not kept).
    const kept = (category: string | null, admitted: string | null): boolean => {
      const inList =
        category === null ? null : (POLITICS_CATEGORIES as readonly string[]).includes(category);
      const stamped = admitted !== null;
      return inList === true || stamped;
    };
    const stamp = "2026-11-08T10:00:00Z";
    for (const category of [...POLITICS_CATEGORIES, "genel", "ekonomi", "teknoloji", "dunya", null]) {
      for (const admitted of [null, stamp]) {
        expect(kept(category, admitted), `${category} / ${admitted}`).toBe(
          isPoliticsMember({ category, politics_admitted_at: admitted }),
        );
      }
    }
    expect(kept("genel", null)).toBe(false);
    expect(kept(null, stamp)).toBe(true);
  });

  it("the filter sits in day_articles, so every entity (and the day's whole token pipeline) reads the same scope", () => {
    const dayBlock = /day_articles as \([\s\S]*?\),\s*toks as/.exec(body);
    expect(dayBlock, "day_articles block").not.toBeNull();
    expect(dayBlock![0]).toContain(SCOPE_BEGIN);
    expect(dayBlock![0]).toContain("a.politics_admitted_at is not null");
  });
});

// ---------------------------------------------------------------------------
// The operator runbook.
// ---------------------------------------------------------------------------

describe("182 docs/migration-guide.md", () => {
  let section = "";
  let body182 = "";

  beforeAll(() => {
    const doc = readFileSync(GUIDE, "utf8");
    const at = doc.search(/^## 182\b/m);
    expect(at, "a `## 182` heading").toBeGreaterThan(-1);
    const rest = doc.slice(at + 1);
    const next = rest.search(/^## /m);
    section = next < 0 ? rest : rest.slice(0, next);
    body182 = fnBody(readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), "utf8"));
  });

  it("names the migration, the apply order (migration first, then the app) and that nothing is backfilled", () => {
    expect(section).toContain("182_trends_entity_rollup_politics_scope.sql");
    expect(section).toMatch(/APPLY 182/);
    expect(section).toMatch(/no backfill/i);
    expect(section).toContain("trends_daily_entity_counts_ist_refresh");
    expect(section).toMatch(/DEPLOY (?:the )?app/i);
  });

  it("pins the function fingerprint before (163 / production) and after (182): md5 and length of prosrc", () => {
    expect(section).toContain(PROD_163_MD5);
    expect(section).toContain(String(PROD_163_LENGTH));
    expect(section).toContain(md5(body182));
    expect(section).toContain(String(body182.length));
  });

  it("has a read-only verify block and a rollback that re-runs 163's function", () => {
    expect(section).toMatch(/\*\*Verify\*\*/);
    expect(section).toMatch(/md5\(prosrc\)/);
    expect(section).toMatch(/\*\*Rollback\*\*/);
    expect(section).toContain("163_trends_entity_rollup_guards.sql");
    expect(section).toMatch(/delete from supabase_migrations\.schema_migrations where version = '182'/);
  });

  it("states the replay (BDDK 36 -> 1) and the baseline week", () => {
    expect(section).toMatch(/bddk/i);
    expect(section).toMatch(/\b36\b/);
    expect(section).toMatch(/\bREPLAY\b|replay/i);
    expect(section).toMatch(/8 days|8 gün|sekiz gün/i);
  });
});

describe("182 test matchers have teeth", () => {
  it("withoutPoliticsScope fails to restore 163 when the body carries extra edits", () => {
    const prev = fnBody(readFileSync(resolve(MIGRATIONS_DIR, PREVIOUS), "utf8"));
    const tampered = prev
      .replace("select x.id, x.title, x.source_id, x.published_at, x.created_at\n", `select x.id, x.title, x.source_id, x.published_at, x.created_at${X_COLUMNS}\n`)
      .replace("select y.id, y.title, y.source_id, y.published_at, y.created_at\n", `select y.id, y.title, y.source_id, y.published_at, y.created_at${Y_COLUMNS}\n`)
      .replace(
        "           and a.title is not null\n",
        `${SCOPE_BEGIN}           and x\n${SCOPE_END}           and a.title is not null\n`,
      );
    expect(tampered).not.toBe(prev);
    expect(withoutPoliticsScope(tampered)).toBe(prev);
    expect(withoutPoliticsScope(tampered.replace("v_days    integer", "v_days  integer"))).not.toBe(prev);
  });

  it("cteSpan reads the emap and guard_map of 163", () => {
    const prev = fnBody(readFileSync(resolve(MIGRATIONS_DIR, PREVIOUS), "utf8"));
    expect(cteSpan(prev, "emap")).toContain("('bddk','bddk')");
    expect(cteSpan(prev, "guard_map")).toContain("'tcmb'");
  });
});
