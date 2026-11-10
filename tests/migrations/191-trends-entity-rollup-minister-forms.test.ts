import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  RISING_ENTITIES,
  RISING_FOLD_FROM,
  RISING_FOLD_TO,
  foldTitleGrams,
} from "../../src/lib/trends/rising-entities";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 191 (h110-trendsdata-1): "Yükselen
// Konular" on /trends counted a minister only under the full name ("Mehmet
// Şimşek", "Hakan Fidan"), while about three quarters of the headlines on them
// print the title and the surname ("Bakan Şimşek", "Bakanı Fidan"). 5 Kasım:
// 12 stored against 60 headlines for Şimşek, 10 against 48 for Fidan. 191 is a
// function-only `create or replace` of 182's refresh function: 182's body plus
// four emap pairs, the new RISING_ENTITIES tokens.
//
// Style mirrors tests/migrations/182-trends-entity-rollup-politics-scope.test.ts:
// comments are stripped before every code assertion so prose can never satisfy a
// guard. Layers:
//   1. the contract (signature, security, grants, no data writes, no backfill);
//   2. 191's function body = 182's body once the four emap pairs are removed
//      (and 182's body is the production body: the fingerprint of the header);
//   3. the emap deep-equals the flattened RISING_ENTITIES: this is the CURRENT
//      parity check (112's own emap is history, see tests/migrations/112);
//   4. a JS twin of the tokenizer run on the SQL's own emap.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "191_trends_entity_rollup_minister_forms.sql";
const PREVIOUS = "182_trends_entity_rollup_politics_scope.sql";
const GUIDE = resolve(REPO_ROOT, "docs", "migration-guide.md");
const FN = "public.trends_daily_entity_counts_ist_refresh";

// What production holds for the function before 191 (read-only, 2026-11-10):
// md5(prosrc) and length(prosrc). It equals 182's body, byte for byte.
const PROD_182_MD5 = "045d9ee0610f00467d1b2da1474911cc";
const PROD_182_LENGTH = 8247;

/** The four pairs 191 adds to the emap, in the order RISING_ENTITIES flattens them. */
const NEW_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["bakan simsek", "simsek"],
  ["bakani simsek", "simsek"],
  ["bakan fidan", "fidan"],
  ["bakani fidan", "fidan"],
];

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

const pairText = ([t, e]: readonly [string, string]) => `('${t}','${e}'),`;

/** 191's body with the four new emap pairs removed (each must be there exactly once). */
function withoutNewPairs(body: string): string {
  let out = body;
  for (const pair of NEW_PAIRS) {
    expect(out.split(pairText(pair)), `${pairText(pair)} exactly once`).toHaveLength(2);
    out = out.replace(pairText(pair), "");
  }
  return out;
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

/** The (token, entity) pairs of an emap span, in order. */
function emapPairs(span: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const pairRe = /\(\s*'([a-z0-9 ]+)'\s*,\s*'([a-z0-9-]+)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(span)) !== null) pairs.push([m[1]!, m[2]!]);
  return pairs;
}

/** The part of the file before `begin;`: the header comment. */
function headerOf(sql: string): string {
  return sql.slice(0, sql.search(/^begin\s*;/im));
}

describe("migration 191_trends_entity_rollup_minister_forms.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let body = "";
  let prevSql = "";
  let prev = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = readFileSync(path, "utf8");
    code = stripComments(sql);
    body = fnBody(sql);
    prevSql = readFileSync(resolve(MIGRATIONS_DIR, PREVIOUS), "utf8");
    prev = fnBody(prevSql);
  });

  // -- hygiene ---------------------------------------------------------------

  it("contains the ledger insert for '191'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'191'\s*,\s*'191_trends_entity_rollup_minister_forms'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
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

  it("documents the fingerprint, why, the replay, the apply order, rollback and the recompute", () => {
    const header = headerOf(sql);
    expect(header).toMatch(/\bWHY\b/);
    expect(header).toMatch(/FINGERPRINT/);
    expect(header).toContain(PROD_182_MD5);
    expect(header).toContain(String(PROD_182_LENGTH));
    expect(header).toContain(md5(body));
    expect(header).toContain(String(body.length));
    expect(header).toMatch(/REPLAY/);
    expect(header).toMatch(/DEPLOY ORDER|APPLY ORDER/);
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toMatch(/RECOMPUTE/);
  });

  it("says the recompute is required and what it is: the rollup's own function over its own derived rows, no source table written", () => {
    const header = headerOf(sql);
    const recompute = header.slice(header.indexOf("RECOMPUTE"));
    expect(recompute).toContain("select public.trends_daily_entity_counts_ist_refresh(10)");
    expect(recompute).toMatch(/service_role/);
    expect(recompute).toMatch(/must not be skipped|do not skip|required/i);
    expect(recompute).toMatch(/no source table is written/i);
    expect(recompute).toMatch(/derived rows|own derived/i);
    expect(recompute).toMatch(/all[- ]category/i);
    expect(recompute).toMatch(/0\.5 s per day/);
    // why it cannot be skipped: a ranked day against a stale full-name baseline
    expect(recompute).toMatch(/false(?:ly)? ris/i);
    expect(recompute).toMatch(/8 days/);
  });

  // -- the function, signature and security as 182 ------------------------------------

  it("replaces the function with the identical signature, SECURITY DEFINER, search_path '' and custom plans", () => {
    expect(code).toMatch(
      new RegExp(
        `create\\s+or\\s+replace\\s+function\\s+${esc(FN)}\\s*\\(\\s*p_days\\s+integer\\s+default\\s+2\\s*\\)\\s*returns\\s+integer\\s+language\\s+plpgsql\\s+security\\s+definer\\s+set\\s+search_path\\s*=\\s*''\\s+set\\s+plan_cache_mode\\s*=\\s*force_custom_plan\\s+as\\s+\\$fn\\$`,
        "i",
      ),
    );
  });

  it("the statement head (everything before the body) is 182's, character for character", () => {
    const head = (text: string) => {
      const i = stripComments(text).search(/create\s+or\s+replace\s+function/i);
      const j = stripComments(text).indexOf("$fn$");
      return stripComments(text).slice(i, j).replace(/\s+/g, " ").trim();
    };
    expect(head(sql)).toBe(head(prevSql));
  });

  it("keeps the advisory lock and the never-raise exception handler of 182", () => {
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

  it("the revoke and grant statements are 182's, unchanged", () => {
    const grants = (text: string) =>
      stripComments(text)
        .split(";")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((s) => /^(revoke|grant)\b/i.test(s));
    expect(grants(sql)).toEqual(grants(prevSql));
    expect(grants(sql)).toHaveLength(2);
  });

  it("restates the function comment and mentions 191, 182, 163 and 112", () => {
    expect(code).toMatch(
      new RegExp(`comment\\s+on\\s+function\\s+${esc(FN)}\\s*\\(\\s*integer\\s*\\)\\s+is\\s+'`, "i"),
    );
    const comment = /comment\s+on\s+function[\s\S]*?'\s*;/i.exec(code)![0];
    for (const v of ["191", "182", "163", "112"]) expect(comment).toContain(v);
    expect(comment).toMatch(/Bakan/);
  });

  // -- no write in the file: the recompute is a separate, named operator step ---------

  it("writes nothing itself: no DO block, no call of the function, no direct write to the rollup", () => {
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
    // the only statement that touches a ledger is the 191 row
    expect((code.match(/\binsert\s+into\b/gi) ?? []).length).toBe(2);
  });

  // -- the body is 182's body plus four emap pairs ----------------------------------------

  it("182's function body is the production body (md5 and length of prosrc)", () => {
    expect(md5(prev)).toBe(PROD_182_MD5);
    expect(prev.length).toBe(PROD_182_LENGTH);
  });

  it("191's body equals 182's body once the four new emap pairs are removed", () => {
    expect(withoutNewPairs(body)).toBe(prev);
  });

  it("only the emap differs from 182: everything outside it is byte-identical", () => {
    const strip = (b: string) => b.replace(cteSpan(b, "emap"), "<emap>");
    expect(strip(body)).toBe(strip(prev));
    expect(cteSpan(body, "emap")).not.toBe(cteSpan(prev, "emap"));
  });

  it("guard_map is unchanged from 182, and the 163 guard and 182 scope blocks are still there once", () => {
    expect(cteSpan(body, "guard_map")).toBe(cteSpan(prev, "guard_map"));
    expect(body.split("      -- 163 guards begin\n")).toHaveLength(2);
    expect(body.split("      -- 163 guards end\n")).toHaveLength(2);
    expect(body.split("           -- 182 politics scope begin\n")).toHaveLength(2);
    expect(body.split("           -- 182 politics scope end\n")).toHaveLength(2);
    // neither new entity is guarded: 'bakan fidan' and 'bakan simsek' name the minister on their own
    expect(cteSpan(body, "guard_map")).not.toMatch(/\('(?:simsek|fidan)'/);
  });

  // -- parity with RISING_ENTITIES (the current check; 112's emap is history) ------------

  it("the emap VALUES pairs deep-equal the flattened RISING_ENTITIES (token, key)", () => {
    const span = cteSpan(body, "emap");
    const pairs = emapPairs(span);
    const expected = RISING_ENTITIES.flatMap((e) => e.tokens.map((t): [string, string] => [t, e.key]));
    expect(pairs).toEqual(expected);
    // Nothing else hides in the VALUES body besides those pairs.
    const inner = /values([\s\S]*?)\)\s*,\s*day_articles as/.exec(stripComments(span))![1]! + ")";
    const residue = inner.replace(/\(\s*'[a-z0-9 ]+'\s*,\s*'[a-z0-9-]+'\s*\)/g, "").replace(/[\s,()]/g, "");
    expect(residue).toBe("");
    // No duplicate token (each token maps to exactly one entity).
    expect(new Set(pairs.map((p) => p[0])).size).toBe(pairs.length);
  });

  it("the four new pairs sit beside the existing simsek and fidan pairs, in vocabulary order", () => {
    const tokens = emapPairs(cteSpan(body, "emap")).map((p) => p[0]);
    const at = (t: string) => tokens.indexOf(t);
    expect(at("mehmet simsek")).toBeGreaterThan(-1);
    expect(at("bakan simsek")).toBe(at("mehmet simsek") + 1);
    expect(at("bakani simsek")).toBe(at("mehmet simsek") + 2);
    expect(at("hakan fidan")).toBe(at("mehmet simsek") + 3);
    expect(at("bakan fidan")).toBe(at("hakan fidan") + 1);
    expect(at("bakani fidan")).toBe(at("hakan fidan") + 2);
  });

  it("the emap holds 73 pairs (182's 69 plus 4) over the same 62 entities as 182 (only tokens grew)", () => {
    const now = emapPairs(cteSpan(body, "emap"));
    const before = emapPairs(cteSpan(prev, "emap"));
    expect(before.length).toBe(69);
    expect(now.length).toBe(73);
    expect(now.length - before.length).toBe(4);
    expect(new Set(now.map((p) => p[1]))).toEqual(new Set(before.map((p) => p[1])));
    expect(new Set(now.map((p) => p[1])).size).toBe(62);
  });

  it("the translate() literals still equal RISING_FOLD_FROM / RISING_FOLD_TO", () => {
    const m = /translate\s*\(\s*a\.title\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/i.exec(code);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(RISING_FOLD_FROM);
    expect(m![2]).toBe(RISING_FOLD_TO);
  });
});

// ---------------------------------------------------------------------------
// The JS twin on the SQL's own emap: 112's tokenizer (foldTitleGrams, then a join
// of grams against the emap, `select distinct id, entity`).
// ---------------------------------------------------------------------------

describe("191 emap, JS twin of the tokenizer on the shipped pairs", () => {
  let emap: Array<[string, string]> = [];

  beforeAll(() => {
    emap = emapPairs(cteSpan(fnBody(readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), "utf8")), "emap"));
  });

  /** The entities a title is counted for, through the SQL's emap (before the 163 guards, which never touch these two). */
  function hits(title: string): Set<string> {
    const grams = new Set(foldTitleGrams(title));
    return new Set(emap.filter(([token]) => grams.has(token)).map(([, entity]) => entity));
  }

  it.each([
    ["Bakan Şimşek'ten enflasyon açıklaması", "simsek"],
    ["Hazine ve Maliye Bakanı Şimşek: Faiz indirimi sürecek", "simsek"],
    ["Mehmet Şimşek: Fiyat istikrarı önceliğimiz", "simsek"],
    ["Dışişleri Bakanı Fidan Mısırlı mevkidaşıyla görüştü", "fidan"],
    ["Bakan Fidan'dan KKTC açıklaması", "fidan"],
    ["Dışişleri Bakanı Hakan Fidan Moskova'da", "fidan"],
  ])("%s is counted for %s", (title, entity) => {
    expect(hits(title).has(entity)).toBe(true);
  });

  it.each([
    "Vali Yılmaz Şimşek törene katıldı",
    "Bakan Yumaklı fidan dikti",
    "Şimşek çaktı, sağanak yağış uyarısı",
    "Başkan Fidan Yılmaz açıklama yaptı",
  ])("is no hit for either minister: %s", (title) => {
    const h = hits(title);
    expect(h.has("simsek"), title).toBe(false);
    expect(h.has("fidan"), title).toBe(false);
  });

  it("counts the SQL's hits the same as RISING_ENTITIES for every fixture title", () => {
    const titles = [
      "Bakan Şimşek'ten enflasyon açıklaması",
      "Dışişleri Bakanı Fidan, TBMM'de konuştu",
      "Hakan Fidan ve Mehmet Şimşek zirvede",
      "Bakanı Şimşek: Borsa İstanbul güne yükselişle başladı",
      "Erdoğan Trump ile görüştü",
      "",
    ];
    for (const title of titles) {
      const viaVocabulary = new Set(
        RISING_ENTITIES.filter((e) => e.tokens.some((t) => foldTitleGrams(title).includes(t))).map((e) => e.key),
      );
      expect(hits(title), title).toEqual(viaVocabulary);
    }
  });
});

// ---------------------------------------------------------------------------
// The operator runbook.
// ---------------------------------------------------------------------------

describe("191 docs/migration-guide.md", () => {
  let section = "";
  let body191 = "";

  beforeAll(() => {
    const doc = readFileSync(GUIDE, "utf8");
    const at = doc.search(/^## 191\b/m);
    expect(at, "a `## 191` heading").toBeGreaterThan(-1);
    const rest = doc.slice(at + 1);
    const next = rest.search(/^## /m);
    section = next < 0 ? rest : rest.slice(0, next);
    body191 = fnBody(readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), "utf8"));
  });

  it("names the migration and the apply order: apply, then recompute immediately; the app has no ordering constraint", () => {
    expect(section).toContain("191_trends_entity_rollup_minister_forms.sql");
    expect(section).toMatch(/APPLY 191/);
    expect(section).toContain("trends_daily_entity_counts_ist_refresh");
    expect(section).toContain("select public.trends_daily_entity_counts_ist_refresh(10)");
    expect(section).toMatch(/service_role/);
    expect(section).toMatch(/immediately/i);
    expect(section).toMatch(/must not be skipped|do not skip|required/i);
  });

  it("pins the function fingerprint before (182 / production) and after (191): md5 and length of prosrc", () => {
    expect(section).toContain(PROD_182_MD5);
    expect(section).toContain(String(PROD_182_LENGTH));
    expect(section).toContain(md5(body191));
    expect(section).toContain(String(body191.length));
  });

  it("has a read-only verify block and a rollback that re-runs 182's function, deletes ledger row 191, then recomputes", () => {
    expect(section).toMatch(/\*\*Verify\*\*/);
    expect(section).toMatch(/md5\(prosrc\)/);
    expect(section).toMatch(/trends_daily_entity_counts_ist_rollup/);
    expect(section).toMatch(/\*\*Rollback\*\*/);
    expect(section).toContain("182_trends_entity_rollup_politics_scope.sql");
    expect(section).toMatch(/delete from supabase_migrations\.schema_migrations where version = '191'/);
    const rollback = section.slice(section.indexOf("**Rollback**"));
    expect(rollback.indexOf("182_trends_entity_rollup_politics_scope.sql")).toBeLessThan(
      rollback.indexOf("version = '191'"),
    );
    expect(rollback.indexOf("version = '191'")).toBeLessThan(
      rollback.indexOf("trends_daily_entity_counts_ist_refresh(10)"),
    );
  });

  it("states the replay (per-day Şimşek and Fidan counts, old against new) and the baseline-week hazard", () => {
    expect(section).toMatch(/\bREPLAY\b|replay/i);
    expect(section).toMatch(/simsek|Şimşek/);
    expect(section).toMatch(/fidan|Fidan/);
    expect(section).toMatch(/\b60\b/);
    expect(section).toMatch(/\b48\b/);
    expect(section).toMatch(/8 days|8 gün|sekiz gün/i);
    expect(section).toMatch(/false/i);
  });
});

describe("191 test matchers have teeth", () => {
  it("withoutNewPairs restores 182 only when exactly the four pairs were added", () => {
    const prev = fnBody(readFileSync(resolve(MIGRATIONS_DIR, PREVIOUS), "utf8"));
    const tampered = prev
      .replace("('mehmet simsek','simsek'),", "('mehmet simsek','simsek'),('bakan simsek','simsek'),('bakani simsek','simsek'),")
      .replace("('hakan fidan','fidan'),", "('hakan fidan','fidan'),('bakan fidan','fidan'),('bakani fidan','fidan'),");
    expect(tampered).not.toBe(prev);
    expect(withoutNewPairs(tampered)).toBe(prev);
    expect(withoutNewPairs(tampered.replace("v_days    integer", "v_days  integer"))).not.toBe(prev);
    // a fifth pair is not hidden by the matcher
    const extra = tampered.replace("('hakan fidan','fidan'),", "('hakan fidan','fidan'),('bakan yerlikaya','yerlikaya'),");
    expect(withoutNewPairs(extra)).not.toBe(prev);
  });

  it("cteSpan reads the emap and guard_map of 182, and emapPairs reads their pairs", () => {
    const prev = fnBody(readFileSync(resolve(MIGRATIONS_DIR, PREVIOUS), "utf8"));
    expect(cteSpan(prev, "emap")).toContain("('mehmet simsek','simsek')");
    expect(cteSpan(prev, "guard_map")).toContain("'tcmb'");
    const pairs = emapPairs(cteSpan(prev, "emap"));
    expect(pairs[0]).toEqual(["akp", "akp"]);
    expect(pairs).toContainEqual(["hakan fidan", "fidan"]);
    expect(pairs).not.toContainEqual(["bakan fidan", "fidan"]);
  });
});
