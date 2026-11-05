import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { entityByKey, entityHubPatterns, foldEntityText } from "@/lib/entities/entity-hub";
import { RISING_ENTITIES, RISING_FOLD_FROM, RISING_FOLD_TO } from "@/lib/trends/rising-entities";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 156 (h34-reader-5, hunt 34), modelled
// on tests/migrations/125-entity-cluster-ids-v2.test.ts.
//
// 125's entity_cluster_ids_v2 runs the entity regex over title_tr || title_tr_neutral
// || summary_tr. A feed that pastes other stories' headlines under an article leaves
// them in summary_tr, so d91ab2f1 (Erdoğan returns from Korea) listed under
// /gundem/trump through "...İşte ABD'deki seçim hezimetinin nedeni! Trump...". 156
// re-creates the function with ONE changed term: the summary contributes only the
// text before its first newline (split_part(summary_tr, E'\n', 1)). Signature, return
// shape, attributes, the 083 live predicate, the order, the grants and the comment
// are 125's, byte for byte. No table, column, index, trigger or data is touched.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "156_entity_cluster_ids_v3.sql";
const PREVIOUS = "125_entity_cluster_ids_v2.sql";
const FN = "entity_cluster_ids_v2";

const OLD_TERM = "coalesce(c.summary_tr, '')";
const NEW_TERM = "pg_catalog.split_part(coalesce(c.summary_tr, ''), E'\\n', 1)";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Collapse all whitespace runs to one space. */
function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Blank every single-quoted string literal (doubled quotes included). */
function blankStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** The `create or replace function public.<name>(...) ... $fn$ ... $fn$;` block. */
function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

/** Everything before `as $fn$`: signature, return shape, attributes. */
function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

/** Only the SQL body between the $fn$ quotes. */
function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const SIG = String.raw`\(\s*text\[\]\s*,\s*text\[\]\s*,\s*timestamptz\s*,\s*integer\s*\)`;

describe("migration 156_entity_cluster_ids_v3.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let fn = "";
  let fnBody = "";
  let prevCode = "";
  let prevFn = "";
  let prevBody = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    fn = functionBlock(code, FN);
    fnBody = body(fn);
    prevCode = stripComments(read(resolve(MIGRATIONS_DIR, PREVIOUS)));
    prevFn = functionBlock(prevCode, FN);
    prevBody = body(prevFn);
  });

  it("documents the cause, the measured replay, the body it starts from and the rollback in its header comment", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    for (const word of [
      "h34-reader-5",
      "d91ab2f1",
      "trump",
      "split_part",
      "first newline",
      "125_entity_cluster_ids_v2",
      "083",
      "removed",
      "added",
    ]) {
      expect(head, `header must mention ${word}`).toContain(word);
    }
    expect(head).toContain(
      "delete from supabase_migrations.schema_migrations where version='156';",
    );
    expect(head).toMatch(/^-- 156_entity_cluster_ids_v3\.sql/);
  });

  it("contains the ledger insert for '156' with on conflict do nothing, and it is the only insert", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'156'\s*,\s*'156_entity_cluster_ids_v3'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    const inserts = code.match(/\binsert\s+into\s+[\w.]+/gi) ?? [];
    expect(inserts.map((s) => s.replace(/\s+/g, " ").toLowerCase())).toEqual([
      "insert into supabase_migrations.schema_migrations",
    ]);
  });

  it("is wrapped in a single begin/commit transaction with a 5 s lock_timeout", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
    expect(code.match(/\bbegin\s*;/gi)?.length).toBe(1);
    expect(code.match(/\bcommit\s*;/gi)?.length).toBe(1);
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
  });

  it("is a function replace only: no DROP, ALTER, TRUNCATE, DELETE, UPDATE, new relations or data writes", () => {
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/\balter\s+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bcreate\s+(table|index|view|trigger|extension|policy|schema)\b/i);
    expect(code).not.toMatch(/\bcopy\b/i);
    expect(code.match(/\bcreate\s+or\s+replace\s+function\b/gi)).toHaveLength(1);
    expect(code.match(/\bcreate\s+/gi)).toHaveLength(1);
  });

  it("keeps 125's signature and return shape", () => {
    expect(norm(fn)).toMatch(
      /^create or replace function public\.entity_cluster_ids_v2\( ?p_queries text\[\], p_patterns text\[\], p_since timestamptz default null, p_limit integer default 20 ?\)/i,
    );
    expect(norm(header(fn))).toMatch(/returns table \( ?id uuid, total bigint ?\)/i);
    expect(norm(header(fn))).toBe(norm(header(prevFn)));
  });

  it("is language sql, stable, security definer with an empty search_path (125's attributes)", () => {
    const h = header(fn);
    expect(h).toMatch(/\blanguage\s+sql\b/i);
    expect(h).toMatch(/\bstable\b/i);
    expect(h).toMatch(/\bsecurity\s+definer\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    expect(h).not.toMatch(/\bvolatile\b/i);
    expect(h).not.toMatch(/\bsecurity\s+invoker\b/i);
  });

  it("changes ONE term of 125's body: the summary contributes only the text before its first newline", () => {
    expect(norm(prevBody)).toContain(OLD_TERM);
    expect(norm(prevBody).split(OLD_TERM)).toHaveLength(2); // 125 holds the bare term exactly once
    expect(norm(fnBody)).toContain(NEW_TERM);
    // The whole body is 125's with that single substitution, nothing else.
    expect(norm(fnBody)).toBe(norm(prevBody).replace(OLD_TERM, NEW_TERM));
    // The bare term survives only as the argument of split_part.
    expect(norm(fnBody).split(OLD_TERM)).toHaveLength(2);
    expect(norm(fnBody).replace(NEW_TERM, "")).not.toContain("summary_tr");
  });

  it("still folds exactly like migration 112 and ANDs the regex guard with the prefilter", () => {
    const folded =
      "pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, '') || ' ' || " +
      `${NEW_TERM}, ` +
      `'${RISING_FOLD_FROM}', '${RISING_FOLD_TO}')) ~ any (pg_catalog.array_remove(p_patterns[1:12], ''))`;
    expect(norm(fnBody)).toContain(folded);
    expect(norm(fnBody)).toContain(
      "c.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, pg_catalog.array_to_string(p_queries[1:12], ' or '))",
    );
    // With string literals blanked there is no OR left: every predicate is ANDed.
    expect(blankStrings(fnBody)).not.toMatch(/\bor\b/i);
    expect(norm(fnBody)).toMatch(
      /c\.search_tsv @@ [^;]*?\) and pg_catalog\.lower\(pg_catalog\.translate\(/,
    );
  });

  it("keeps the 083 live predicate, the 14/30 day window, the 1..50 clamp and the order", () => {
    expect(fnBody).toMatch(/\band\s+not\s+c\.is_archived\b/i);
    expect(fnBody).toMatch(/\band\s+c\.article_count\s*>=\s*2\b/i);
    expect(fnBody).toMatch(/\band\s+c\.merged_into\s+is\s+null\b/i);
    // The comment on the predicate line is part of the raw file, not of the comment-stripped code.
    expect(sql).toContain("and not c.is_archived      -- literal copy of the 083 partial-index predicate");
    expect(norm(fnBody)).toContain(
      "c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')",
    );
    expect(fnBody).not.toMatch(/(?<!pg_catalog\.)\bnow\s*\(/i);
    expect(norm(fnBody)).toContain("limit greatest(1, least(coalesce(p_limit, 20), 50))");
    expect(norm(fnBody)).toContain("(pg_catalog.count(*) over ())::bigint");
    expect(norm(fnBody)).toContain("order by c.first_published desc, c.id");
  });

  it("only references schema-qualified relations and functions (search_path is empty)", () => {
    const b = blankStrings(fnBody);
    const rels = [...b.matchAll(/\b(?:from|join)\s+([^\s(,]+)/gi)].map((m) => m[1]!);
    expect(rels.length).toBeGreaterThan(0);
    for (const rel of rels) {
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\.[a-z_]+$/i);
    }
    const calls = [...b.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\(/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter(
        (n) =>
          !["greatest", "least", "coalesce", "select", "in", "over", "interval", "any"].includes(n),
      );
    expect(calls).toEqual([]);
  });

  it("is documented with a comment ending 'service_role only.' that names 156", () => {
    const m = code.match(
      new RegExp(
        String.raw`comment\s+on\s+function\s+public\.entity_cluster_ids_v2\s*${SIG}\s+is\s+('[\s\S]*?service_role only\.')\s*;`,
        "i",
      ),
    );
    expect(m).not.toBeNull();
    expect(m![1]).toContain("156");
    expect(m![1]).toContain("first newline");
  });

  it("is revoked from public/anon/authenticated and granted only to service_role, as in 125", () => {
    expect(code).toMatch(
      new RegExp(
        String.raw`revoke\s+all\s+on\s+function\s+public\.entity_cluster_ids_v2\s*${SIG}\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;`,
        "i",
      ),
    );
    expect(code).toMatch(
      new RegExp(
        String.raw`grant\s+execute\s+on\s+function\s+public\.entity_cluster_ids_v2\s*${SIG}\s+to\s+service_role\s*;`,
        "i",
      ),
    );
    const grants = (code.match(/\bgrant\b[^;]*;/gi) ?? []).map(norm);
    expect(grants).toHaveLength(1);
    for (const g of grants) {
      expect(g).not.toMatch(/\bto\s+anon\b/i);
      expect(g).not.toMatch(/\bauthenticated\b/i);
      expect(g).not.toMatch(/\bpublic\s*;?$/i);
    }
    expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+(all\s+)?(table|tables|sequence|sequences)\b/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
  });

  it("reloads the PostgREST schema cache and is idempotent (create or replace + on conflict do nothing)", () => {
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'\s*;/i);
    expect(code).toMatch(/create\s+or\s+replace\s+function/i);
    expect(code).toMatch(/on\s+conflict\s+do\s+nothing/i);
  });

  it("leaves 125 untouched (it still holds the bare summary term) and sorts after it", () => {
    expect(norm(prevCode)).toContain(OLD_TERM);
    expect(prevCode).not.toMatch(/split_part/i);
    expect(MIGRATION > PREVIOUS).toBe(true);
  });

  it("is the only migration after 125 that re-creates entity_cluster_ids_v2", () => {
    const names = readdirSyncSql().filter((n) => n > PREVIOUS);
    const redefiners = names.filter((n) =>
      /create\s+or\s+replace\s+function\s+public\.entity_cluster_ids_v2\b/i.test(stripComments(read(resolve(MIGRATIONS_DIR, n)))),
    );
    expect(redefiners).toEqual([MIGRATION]);
  });
});

function readdirSyncSql(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort();
}

// ---------------------------------------------------------------------------
// The predicate itself, through a test-only twin: Postgres' `\m` / `\M` word
// anchors both become JS `\b` (as in src/lib/entities/entity-hub.test.ts) and
// `split_part(x, E'\n', 1)` is `x.split("\n")[0]`. Fixtures are the stored rows,
// read-only on 2026-11-05.
// ---------------------------------------------------------------------------

function pgPatternToJs(pattern: string): RegExp {
  return new RegExp(pattern.replace(/\\[mM]/g, "\\b"));
}

/** What 125 matched on: the title, the neutral title and the whole summary. */
function textV2(c: { title: string; neutral: string; summary: string }): string {
  return `${c.title} ${c.neutral} ${c.summary}`;
}

/** What 156 matches on: the same, with the summary cut at its first newline (split_part). */
function textV3(c: { title: string; neutral: string; summary: string }): string {
  return `${c.title} ${c.neutral} ${c.summary.split("\n")[0] ?? ""}`;
}

function hubHit(key: string, text: string): boolean {
  const folded = foldEntityText(text);
  return entityHubPatterns(entityByKey(key)!).some((p) => pgPatternToJs(p).test(folded));
}

const D91 = {
  title: "Cumhurbaşkanı Erdoğan Güney Kore'deki temaslarının ardından yurda döndü",
  neutral: "Cumhurbaşkanı Erdoğan Güney Kore'deki temaslarının ardından yurda döndü",
  summary:
    "Cumhurbaşkanı Erdoğan'ı, \"TUR\" uçağıyla geldiği Atatürk Havalimanı'nda, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, İstanbul Valisi Davut Gül ile AK Parti İstanbul İl Başkanı Abdullah Özdemir ve ilgililer karşıladı.\nCumhurbaşkanı Erdoğan ile eşi Emine Erdoğan ve ziyarette kendisine eşlik eden heyet üyeleri de İstanbul'a geldi.\nAnkara'da kritik güvenlik zirvesi! Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi\nDünyanın gözü ABD'den gelen sonuçlarda! İşte ABD'deki seçim hezimetinin nedeni! Trump...",
};

describe("the 156 predicate on d91ab2f1 (twin of the SQL)", () => {
  it("125 listed it under 'trump' only through the pasted teaser; 156 does not", () => {
    expect(hubHit("trump", textV2(D91))).toBe(true);
    expect(hubHit("trump", textV3(D91))).toBe(false);
    // The only Trump in the row is in the last summary line.
    expect(foldEntityText(`${D91.title} ${D91.neutral} ${D91.summary.split("\n").slice(0, 2).join("\n")}`)).not.toContain("trump");
  });

  it("its own subject keeps its hubs: erdogan through the title, akp through the real first sentence", () => {
    for (const key of ["erdogan", "akp"]) {
      expect(hubHit(key, textV2(D91)), `${key} before`).toBe(true);
      expect(hubHit(key, textV3(D91)), `${key} after`).toBe(true);
    }
  });

  it("a name in the title always matches, whatever the summary looks like", () => {
    const keys = RISING_ENTITIES.map((e) => e.key).slice(0, 12);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const label = entityByKey(key)!.label;
      for (const summary of ["", "\n", "Ilk satır.\nİkinci satır!", "\n\n\n"]) {
        const c = { title: `${label} hakkında yeni gelişme`, neutral: "", summary };
        if (!hubHit(key, textV2(c))) continue; // a label the patterns do not spell as written proves nothing here
        expect(hubHit(key, textV3(c)), `${key} / ${JSON.stringify(summary)}`).toBe(true);
      }
    }
  });

  it("split_part semantics: no newline gives the whole text, a leading newline gives '', null gives ''", () => {
    const c = { title: "", neutral: "", summary: "Trump açıklama yaptı" };
    expect(hubHit("trump", textV3(c))).toBe(true);
    expect(hubHit("trump", textV3({ ...c, summary: "\nTrump açıklama yaptı" }))).toBe(false);
    expect(hubHit("trump", textV3({ ...c, summary: "" }))).toBe(false);
  });
});
