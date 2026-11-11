import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  QUANTITY_GUARD,
  entityHubPatterns,
  entityByKey,
  foldEntityText,
} from "../../src/lib/entities/entity-hub";
import {
  RISING_ENTITIES,
  RISING_HUB_SPECS,
  foldTitleGrams,
} from "../../src/lib/trends/rising-entities";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 163 (h43-entities-3, part C): the
// rollup behind "Yükselen Konular" counted unguarded tokens. "Merkez Bankası
// · Bugün 38 haber" included about a dozen Bank of England headlines, and the
// dolar count included every "158,1 milyar dolar" reserve figure, because
// migration 112 joins title grams to the vocabulary with none of the hub
// guards (RISING_HUB_SPECS excludes for tcmb / aym / meclis, QUANTITY_GUARD
// for dolar) that /gundem/[key] applies. 163 is a function-only
// `create or replace` of 112's refresh function: 112's body plus one `guarded`
// CTE between `hits` and `agg`.
//
// Style mirrors tests/migrations/112-trends-entity-rollup.test.ts: comments are
// stripped before every code assertion so prose can never satisfy a guard. Four
// layers:
//   1. the contract (signature, security, grants, no data writes, no backfill);
//   2. 163's function body = 112's body once the marked guard block is removed
//      (and 112's body is the production body: the fingerprint of the header);
//   3. parity of the SQL regexes with RISING_HUB_SPECS and QUANTITY_GUARD, in
//      both directions;
//   4. a JS twin of the tokenizer + guards, run on the SQL's own regex strings.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "163_trends_entity_rollup_guards.sql";
const PREVIOUS = "112_trends_entity_rollup.sql";
const GUIDE = resolve(REPO_ROOT, "docs", "migration-guide.md");
const FN = "public.trends_daily_entity_counts_ist_refresh";

// What production holds for the function before 163 (read-only, 2026-11-05):
// md5(prosrc) and length(prosrc). It equals 112's body, byte for byte.
const PROD_112_MD5 = "b0a0dcce4dd8df781c35ed7a73af576e";
const PROD_112_LENGTH = 5937;

const GUARD_BEGIN = "      -- 163 guards begin\n";
const GUARD_END = "      -- 163 guards end\n";

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

/** 163's body with the marked guard block removed and `agg` reading `hits` again. */
function withoutGuards(body: string): string {
  const begin = body.indexOf(GUARD_BEGIN);
  const end = body.indexOf(GUARD_END);
  expect(begin, "guards begin marker").toBeGreaterThan(-1);
  expect(end, "guards end marker").toBeGreaterThan(begin);
  return (body.slice(0, begin) + body.slice(end + GUARD_END.length)).replace(
    "from guarded h",
    "from hits h",
  );
}

// -- the hub's own rules, restated from entity-hub.ts so a drift in either is caught --

const foldWords = (text: string): string[] =>
  foldEntityText(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");

/** One alternative of an exclude list: `\m` + words joined by `\s+`; a lone word of <= 3 letters is closed with `\M`. */
function excludeAlt(phrase: string): string {
  const words = foldWords(phrase);
  const closed = words.length === 1 && words[0]!.length <= 3;
  return `\\m${words.join("\\s+")}${closed ? "\\M" : ""}`;
}

/** The base pattern of a trusted form (no guard prefix), as entityHubPatterns builds it. */
function trustedBase(form: string, prefix: boolean): string {
  const words = foldWords(form);
  const body = words.join("\\s+");
  return words.length > 1 ? `\\m${body}` : `\\m${body}${prefix ? "" : "\\M"}`;
}

const GUARDED_KEYS = ["tcmb", "aym", "meclis"] as const;

/** The SQL regex 163 must hold for one guarded entity, derived from RISING_HUB_SPECS. */
function expectedGuard(key: (typeof GUARDED_KEYS)[number]): { excl: string; trusted: string } {
  const spec = RISING_HUB_SPECS[key]!;
  const prefix = spec.hubMatch === "prefix";
  return {
    excl: (spec.excludes ?? []).map(excludeAlt).join("|"),
    trusted: (spec.trusted ?? []).map((f) => trustedBase(f, prefix)).join("|"),
  };
}

/** A PostgreSQL ARE source as a JS RegExp: `\m` / `\M` (word start / end) become `\b`, as in entity-hub.test.ts. */
const pgRegex = (src: string): RegExp => new RegExp(src.replace(/\\[mM]/g, "\\b"));

describe("migration 163_trends_entity_rollup_guards.sql (SQL contract)", () => {
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

  it("contains the ledger insert for '163'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'163'\s*,\s*'163_trends_entity_rollup_guards'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
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
    expect(header).toContain(PROD_112_MD5);
    expect(header).toContain(String(PROD_112_LENGTH));
    expect(header).toMatch(/REPLAY/);
    expect(header).toMatch(/DEPLOY ORDER/);
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toMatch(/NO BACKFILL/);
  });

  // -- the function, signature and security as 112 ----------------------------------

  it("replaces the function with the identical signature, SECURITY DEFINER, search_path '' and custom plans", () => {
    expect(code).toMatch(
      new RegExp(
        `create\\s+or\\s+replace\\s+function\\s+${esc(FN)}\\s*\\(\\s*p_days\\s+integer\\s+default\\s+2\\s*\\)\\s*returns\\s+integer\\s+language\\s+plpgsql\\s+security\\s+definer\\s+set\\s+search_path\\s*=\\s*''\\s+set\\s+plan_cache_mode\\s*=\\s*force_custom_plan\\s+as\\s+\\$fn\\$`,
        "i",
      ),
    );
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

  it("restates the function comment and mentions 163", () => {
    expect(code).toMatch(
      new RegExp(`comment\\s+on\\s+function\\s+${esc(FN)}\\s*\\(\\s*integer\\s*\\)\\s+is\\s+'`, "i"),
    );
    const comment = /comment\s+on\s+function[\s\S]*?'\s*;/i.exec(code)![0];
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

  // -- the body is 112's body plus the guard block ------------------------------------

  it("112's function body is the production body (md5 and length of prosrc)", () => {
    expect(md5(prev)).toBe(PROD_112_MD5);
    expect(prev.length).toBe(PROD_112_LENGTH);
  });

  it("163's body equals 112's body once the marked guard block is removed", () => {
    expect(withoutGuards(body)).toBe(prev);
  });

  it("the guard block is one contiguous span, once, between `hits` and `agg`", () => {
    expect(body.split(GUARD_BEGIN)).toHaveLength(2);
    expect(body.split(GUARD_END)).toHaveLength(2);
    const hitsAt = body.search(/\bhits\s+as\s*\(/);
    const beginAt = body.indexOf(GUARD_BEGIN);
    const endAt = body.indexOf(GUARD_END);
    const aggAt = body.search(/\bagg\s+as\s*\(/);
    expect(hitsAt).toBeGreaterThan(-1);
    expect(beginAt).toBeGreaterThan(hitsAt);
    expect(endAt).toBeGreaterThan(beginAt);
    expect(aggAt).toBeGreaterThan(endAt);
  });

  it("`agg` counts the guarded hits, not the raw ones", () => {
    expect(stripComments(body)).toMatch(
      /agg\s+as\s*\(\s*select\s+h\.entity\s*,\s*count\s*\(\s*\*\s*\)\s*::\s*int\s+as\s+cnt\s+from\s+guarded\s+h\s+group\s+by\s+h\.entity\s*\)/i,
    );
    expect(stripComments(body)).not.toMatch(/from\s+hits\s+h\s+group\s+by/i);
  });

  it("`guarded` joins each hit back to the day's articles for the folded title", () => {
    expect(code).toMatch(
      /guarded\s+as\s*\(\s*select\s+h\.id\s*,\s*h\.entity\s+from\s+hits\s+h\s+join\s+day_articles\s+d\s+on\s+d\.id\s*=\s*h\.id\s+left\s+join\s+guard_map\s+gm\s+on\s+gm\.entity\s*=\s*h\.entity\s+where\s/i,
    );
  });

  it("keeps a hit unless a guard drops it: unguarded entities pass, guarded ones need no exclude or a trusted token", () => {
    expect(code).toMatch(
      /where\s*\(\s*gm\.entity\s+is\s+null\s+or\s+d\.t\s*!~\s*gm\.excl\s+or\s+d\.t\s*~\s*gm\.trusted\s*\)/i,
    );
    expect(code).toMatch(/and\s*\(\s*h\.entity\s*<>\s*'dolar'\s+or\s+d\.t\s*~\s*'[^']+'\s*\)/i);
  });

  // -- parity with the TS vocabulary ---------------------------------------------------

  /** guard_map rows of the SQL: entity -> { excl, trusted }. */
  function sqlGuards(): Map<string, { excl: string; trusted: string }> {
    const span = /guard_map\s*\(\s*entity\s*,\s*excl\s*,\s*trusted\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*guarded\s+as/i.exec(code);
    expect(span, "guard_map VALUES span").not.toBeNull();
    const rows = new Map<string, { excl: string; trusted: string }>();
    const rowRe = /\(\s*'([a-z0-9-]+)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(span![1]!)) !== null) {
      expect(rows.has(m[1]!), `duplicate guard row ${m[1]}`).toBe(false);
      rows.set(m[1]!, { excl: m[2]!, trusted: m[3]! });
    }
    // Nothing else hides in the VALUES body.
    expect(span![1]!.replace(rowRe, "").replace(/[\s,]/g, "")).toBe("");
    return rows;
  }

  function sqlDolarRegex(): string {
    const m = /h\.entity\s*<>\s*'dolar'\s+or\s+d\.t\s*~\s*'([^']+)'/i.exec(code);
    expect(m, "dolar guard literal").not.toBeNull();
    return m![1]!;
  }

  it("guards exactly tcmb, aym and meclis (plus dolar)", () => {
    expect([...sqlGuards().keys()]).toEqual([...GUARDED_KEYS]);
    for (const key of [...GUARDED_KEYS, "dolar"]) expect(entityByKey(key), key).not.toBeNull();
  });

  it.each(GUARDED_KEYS)("%s: the SQL exclude list equals RISING_HUB_SPECS excludes", (key) => {
    const want = expectedGuard(key);
    const got = sqlGuards().get(key)!;
    expect(got.excl).toBe(want.excl);
    expect(want.excl.split("|").length).toBe(RISING_HUB_SPECS[key]!.excludes!.length);
  });

  it.each(GUARDED_KEYS)("%s: the SQL trusted tokens equal RISING_HUB_SPECS trusted", (key) => {
    const want = expectedGuard(key);
    expect(sqlGuards().get(key)!.trusted).toBe(want.trusted);
  });

  it.each(GUARDED_KEYS)(
    "%s: the SQL regexes are the ones the hub itself sends (entityHubPatterns)",
    (key) => {
      const entity = entityByKey(key)!;
      const patterns = entityHubPatterns(entity);
      const got = sqlGuards().get(key)!;
      // The non-trusted pattern is `^(?![\s\S]*(?:<excludes>))...`: same alternation.
      expect(patterns.some((p) => p.startsWith(`^(?![\\s\\S]*(?:${got.excl}))`))).toBe(true);
      // A trusted form is emitted bare: exactly one of the patterns per alternative.
      for (const alt of got.trusted.split("|")) expect(patterns).toContain(alt);
    },
  );

  it("the SQL dolar guard is `\\m` + QUANTITY_GUARD + dolar, the pattern the dolar hub sends", () => {
    const literal = sqlDolarRegex();
    expect(literal).toBe(`\\m${QUANTITY_GUARD}dolar`);
    expect(literal).toContain(QUANTITY_GUARD);
    // The hub pattern ends with the SQL literal. Since h128-hubs-1 it may open with the hub-only foreign
    // veto (`^(?![\s\S]*(?:...))[\s\S]*`, `hubExcludes`, which /trends never reads), and nothing else:
    // the amount guard itself is still word for word the SQL one.
    const patterns = entityHubPatterns(entityByKey("dolar")!);
    expect(patterns).toHaveLength(1);
    const pattern = patterns[0]!;
    expect(pattern.endsWith(literal)).toBe(true);
    const head = pattern.slice(0, pattern.length - literal.length);
    expect(head === "" || /^\^\(\?!\[\\s\\S\]\*\(\?:[^()]*\)\)\[\\s\\S\]\*$/.test(head)).toBe(true);
  });

  it("every SQL regex string is a valid regex (and, in JS, a valid twin)", () => {
    for (const { excl, trusted } of sqlGuards().values()) {
      expect(() => pgRegex(excl)).not.toThrow();
      expect(() => pgRegex(trusted)).not.toThrow();
    }
    expect(() => pgRegex(sqlDolarRegex())).not.toThrow();
  });

  it("the SQL regexes hold no quote, so the literals stay single-line and standard-conforming", () => {
    for (const { excl, trusted } of sqlGuards().values()) {
      expect(excl).not.toContain("'");
      expect(trusted).not.toContain("'");
    }
    expect(sqlDolarRegex()).not.toContain("'");
  });
});

// ---------------------------------------------------------------------------
// The JS twin: the tokenizer of 112 (foldTitleGrams + the emap of the
// vocabulary) followed by the guards, run on the regex strings the SQL file
// holds. Not a mock of the SQL: the strings under test are the shipped ones.
// ---------------------------------------------------------------------------

describe("163 guards, JS twin on the shipped regexes", () => {
  let guards: Map<string, { excl: RegExp; trusted: RegExp }>;
  let dolar: RegExp;

  beforeAll(() => {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), "utf8");
    const code = stripComments(sql);
    guards = new Map();
    const rowRe = /\(\s*'(tcmb|aym|meclis)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(code)) !== null) {
      guards.set(m[1]!, { excl: pgRegex(m[2]!), trusted: pgRegex(m[3]!) });
    }
    dolar = pgRegex(/h\.entity\s*<>\s*'dolar'\s+or\s+d\.t\s*~\s*'([^']+)'/i.exec(code)![1]!);
  });

  /** The entities a title is counted for: 112's tokenizer and emap, then (optionally) 163's guards. */
  function rollupHits(title: string, guarded: boolean): Set<string> {
    const grams = new Set(foldTitleGrams(title));
    const hits = new Set<string>();
    for (const e of RISING_ENTITIES) {
      if (e.tokens.some((t) => grams.has(t))) hits.add(e.key);
    }
    if (!guarded) return hits;

    const t = foldEntityText(title);
    for (const key of [...hits]) {
      const g = guards.get(key);
      if (g !== undefined && g.excl.test(t) && !g.trusted.test(t)) hits.delete(key);
    }
    if (hits.has("dolar") && !dolar.test(t)) hits.delete("dolar");
    return hits;
  }

  it("'İngiltere Merkez Bankası faizi artırdı' is no tcmb hit (the unguarded rollup counted it)", () => {
    const title = "İngiltere Merkez Bankası faizi artırdı";
    expect(rollupHits(title, false).has("tcmb")).toBe(true);
    expect(rollupHits(title, true).has("tcmb")).toBe(false);
  });

  it("'Merkez Bankası rezervleri 158,1 milyar dolar oldu' is a tcmb hit and no dolar hit", () => {
    const title = "Merkez Bankası rezervleri 158,1 milyar dolar oldu";
    expect(rollupHits(title, false).has("dolar")).toBe(true);
    const hits = rollupHits(title, true);
    expect(hits.has("tcmb")).toBe(true);
    expect(hits.has("dolar")).toBe(false);
  });

  it("'Dolar/TL rekor kırdı' is a dolar hit", () => {
    expect(rollupHits("Dolar/TL rekor kırdı", true).has("dolar")).toBe(true);
  });

  it("'TCMB, Fed kararını değerlendirdi' is a tcmb hit (TCMB is trusted, the Fed cue does not veto it)", () => {
    const title = "TCMB, Fed kararını değerlendirdi";
    expect(rollupHits(title, true).has("tcmb")).toBe(true);
  });

  it("a foreign cue vetoes the bare 'Merkez Bankası' wherever it stands in the title", () => {
    for (const title of [
      "Avrupa Merkez Bankası faiz kararını açıkladı",
      "ABD Merkez Bankası Fed faizi sabit tuttu: Merkez Bankası açıklaması",
      "Merkez Bankası Başkanı Powell konuştu, Japonya Merkez Bankası da faiz artırdı",
      "Rusya Merkez Bankası politika faizini düşürdü",
    ]) {
      expect(rollupHits(title, false).has("tcmb"), title).toBe(true);
      expect(rollupHits(title, true).has("tcmb"), title).toBe(false);
    }
  });

  it("a Turkish 'Merkez Bankası' story with no foreign cue is kept", () => {
    for (const title of [
      "Merkez Bankası faizi sabit tuttu",
      "Merkez Bankası rezervleri açıklandı",
      "TCMB rezervleri arttı",
    ]) {
      expect(rollupHits(title, true).has("tcmb"), title).toBe(true);
    }
  });

  it("aym: Polonya / federal / KKTC cues veto 'Anayasa Mahkemesi'; AYM is trusted", () => {
    expect(rollupHits("Polonya Anayasa Mahkemesi kararını verdi", false).has("aym")).toBe(true);
    expect(rollupHits("Polonya Anayasa Mahkemesi kararını verdi", true).has("aym")).toBe(false);
    expect(rollupHits("Federal Anayasa Mahkemesi Almanya'da karar verdi", true).has("aym")).toBe(false);
    expect(rollupHits("Anayasa Mahkemesi başvuruyu reddetti", true).has("aym")).toBe(true);
    expect(rollupHits("Polonya'daki karar sonrası AYM'den açıklama", true).has("aym")).toBe(true);
  });

  it("meclis: foreign and municipal cues veto 'Meclis'; TBMM and Büyük Millet Meclisi are trusted", () => {
    expect(rollupHits("İsrail Meclis oturumunu iptal etti", false).has("meclis")).toBe(true);
    expect(rollupHits("İsrail Meclis oturumunu iptal etti", true).has("meclis")).toBe(false);
    expect(rollupHits("Belediye meclis toplantısı yapıldı", true).has("meclis")).toBe(false);
    expect(rollupHits("İTO meclis toplantısı yapıldı", true).has("meclis")).toBe(false);
    expect(rollupHits("Meclis tatile girdi", true).has("meclis")).toBe(true);
    expect(rollupHits("TBMM Genel Kurulu İsrail tezkeresini görüştü", true).has("meclis")).toBe(true);
  });

  it("dolar: an amount is not the currency, any non-amount 'dolar' keeps the hit", () => {
    for (const title of [
      "100 dolar yardım",
      "2,1 milyar dolar anlaşma imzalandı",
      "Bin dolar ceza",
      "5 milyon dolar fon",
      "3 trilyon dolar piyasa değeri",
    ]) {
      expect(rollupHits(title, false).has("dolar"), title).toBe(true);
      expect(rollupHits(title, true).has("dolar"), title).toBe(false);
    }
    for (const title of [
      "Dolar güne yükselişle başladı",
      "Dolar 35 liradan işlem görüyor",
      "Bir dolar kaç lira oldu",
      "Dolar 100 dolar seviyesini aştı", // the first 'Dolar' is the currency
    ]) {
      expect(rollupHits(title, true).has("dolar"), title).toBe(true);
    }
  });

  it("changes nothing for any other entity, and never adds a hit", () => {
    const titles = [
      "Erdoğan TBMM'de konuştu",
      "CHP Genel Başkanı Özgür Özel Meclis'e seslendi",
      "ABD Dışişleri Bakanı İran ile görüştü",
      "Borsa İstanbul güne yükselişle başladı",
      "Enflasyon beklentilerin üzerinde geldi, faiz kararı bekleniyor",
      "Merkez Bankası enflasyon raporu: dolar ve altın",
      "Polonya Anayasa Mahkemesi, Rusya ve Ukrayna",
      "MSB: Suriye sınırında operasyon",
      "",
    ];
    const guarded = new Set(["tcmb", "aym", "meclis", "dolar"]);
    for (const title of titles) {
      const before = rollupHits(title, false);
      const after = rollupHits(title, true);
      for (const key of after) expect(before.has(key), `${title}: added ${key}`).toBe(true);
      for (const key of before) {
        if (!guarded.has(key)) expect(after.has(key), `${title}: lost ${key}`).toBe(true);
      }
    }
  });

  it("the twin has teeth: the unguarded tokenizer does count every fixture the guards drop", () => {
    expect(rollupHits("Rusya Merkez Bankası faiz kararı", false).has("tcmb")).toBe(true);
    expect(rollupHits("Rusya Merkez Bankası faiz kararı", true).has("tcmb")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The operator runbook.
// ---------------------------------------------------------------------------

describe("163 docs/migration-guide.md", () => {
  let section = "";
  let body163 = "";

  beforeAll(() => {
    const doc = readFileSync(GUIDE, "utf8");
    const at = doc.search(/^## 163\b/m);
    expect(at, "a `## 163` heading").toBeGreaterThan(-1);
    const rest = doc.slice(at + 1);
    const next = rest.search(/^## /m);
    section = next < 0 ? rest : rest.slice(0, next);
    body163 = fnBody(readFileSync(resolve(MIGRATIONS_DIR, MIGRATION), "utf8"));
  });

  it("names the migration, the apply order and that nothing is backfilled", () => {
    expect(section).toContain("163_trends_entity_rollup_guards.sql");
    expect(section).toMatch(/APPLY 163/);
    expect(section).toMatch(/no backfill/i);
    expect(section).toContain("trends_daily_entity_counts_ist_refresh");
  });

  it("pins the function fingerprint before (112 / production) and after (163): md5 and length of prosrc", () => {
    expect(section).toContain(PROD_112_MD5);
    expect(section).toContain(String(PROD_112_LENGTH));
    expect(section).toContain(md5(body163));
    expect(section).toContain(String(body163.length));
  });

  it("has a read-only verify block and a rollback that re-runs 112's function", () => {
    expect(section).toMatch(/\*\*Verify\*\*/);
    expect(section).toMatch(/md5\(prosrc\)/);
    expect(section).toMatch(/\*\*Rollback\*\*/);
    expect(section).toContain("112_trends_entity_rollup.sql");
    expect(section).toMatch(/delete from supabase_migrations\.schema_migrations where version = '163'/);
  });

  it("states the replay numbers for tcmb and dolar", () => {
    expect(section).toMatch(/tcmb/);
    expect(section).toMatch(/dolar/);
    expect(section).toMatch(/\bREPLAY\b|replay/i);
  });
});

describe("163 test matchers have teeth", () => {
  it("withoutGuards fails to restore 112 when the body carries extra edits", () => {
    const prev = fnBody(readFileSync(resolve(MIGRATIONS_DIR, PREVIOUS), "utf8"));
    const tampered = prev.replace(
      "      agg as (",
      `${GUARD_BEGIN}      -- x\n${GUARD_END}      agg as (`,
    );
    expect(withoutGuards(tampered)).toBe(prev);
    expect(withoutGuards(tampered.replace("v_days    integer", "v_days  integer"))).not.toBe(prev);
  });

  it("the exclude derivation closes only a lone word of three letters or fewer", () => {
    expect(excludeAlt("fed")).toBe("\\mfed\\M");
    expect(excludeAlt("ecb")).toBe("\\mecb\\M");
    expect(excludeAlt("gkry")).toBe("\\mgkry");
    expect(excludeAlt("avrupa merkez")).toBe("\\mavrupa\\s+merkez");
  });

  it("pgRegex keeps a word boundary: 'fed' does not hit 'federasyon'", () => {
    expect(pgRegex("\\mfed\\M").test("federasyon")).toBe(false);
    expect(pgRegex("\\mfed\\M").test("fed kararı")).toBe(true);
  });
});
