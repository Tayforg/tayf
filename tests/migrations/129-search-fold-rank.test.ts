import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SEARCH_FOLD_FROM, SEARCH_FOLD_TO, foldTr } from "@/lib/clusters/turkish-query";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 129 ("search fold + ranked archive
// search"), modelled on 083-reader-query-rpcs.test.ts and
// 127-headline-pick-index.test.ts.
//
// Hunt 9 (2026-11-01): typing `sisli`, `cumhurbaskani`, `imamoglu` or `ozel`
// found nothing on production (the stored lexemes keep their Turkish letters),
// and the archive was ordered by article_count alone, so `borsa` (stem `bor`)
// listed Bora rows next to Borsa Istanbul. 129 adds:
//   - public.tayf_search_fold(text): the house fold of 112/125/126 (translate,
//     then lower) with the lower() pinned to the C collation so it is honestly
//     IMMUTABLE and locale independent;
//   - a partial GIN index over to_tsvector('turkish', tayf_search_fold(<the
//     three search_tsv columns>));
//   - search_cluster_ids(text[], text, integer): matches either index, ranks
//     literal word-start title hits first, then relevance plus recency, and
//     keeps article_count as a tie-break only.
// ---------------------------------------------------------------------------

const MIGRATION_PATH = resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "129_search_fold_rank.sql",
);
const SEARCH_QUERY_TS = resolve(__dirname, "..", "..", "src", "lib", "clusters", "search-query.ts");

const INDEX_NAME = "clusters_search_fold_live_idx";

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in an error message never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
function fnHeader(block: string): string {
  return block.slice(0, block.search(/\bas\s+\$fn\$/i));
}

/** Only the SQL body between the $fn$ quotes. */
function fnBody(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

/** Split on commas that sit outside any parentheses. */
function topLevelSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim());
}

/** The argument lists of every `<fn>(...)` call in `src`, found with balanced parentheses. */
function callArgs(src: string, fn: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`${fn}\\s*\\(`, "gi");
  for (const m of src.matchAll(re)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    let inStr = false;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === "'") inStr = !inStr;
      else if (!inStr && ch === "(") depth++;
      else if (!inStr && ch === ")") depth--;
    }
    out.push(topLevelSplit(src.slice(start, i - 1)));
  }
  return out;
}

/** TS emulation of the SQL fold: translate(), delete U+0307, lower() under the C collation (ASCII only). */
function emulateSqlFold(s: string): string {
  const from = [...SEARCH_FOLD_FROM, "̇"];
  const to = [...SEARCH_FOLD_TO];
  let out = "";
  for (const ch of s) {
    const i = from.indexOf(ch);
    const mapped = i < 0 ? ch : (to[i] ?? ""); // a FROM char with no TO char is deleted
    out += mapped.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  }
  return out;
}

let sql = "";
let code = "";
let head = "";
let headText = "";
let foldFn = "";
let searchFn = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, "utf8");
  code = stripComments(sql);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
  foldFn = functionBlock(code, "tayf_search_fold");
  searchFn = functionBlock(code, "search_cluster_ids");
});

describe("129 ledger and structure", () => {
  it("contains the ledger insert for '129' with on conflict do nothing", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'129'\s*,\s*'129_search_fold_rank'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;/i,
    );
  });

  it("is wrapped in a single begin/commit and sets lock_timeout 5s / statement_timeout 60s first", () => {
    expect([...code.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
    expect(code.trimStart()).toMatch(
      /^begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i,
    );
    expect(code.trimEnd()).toMatch(/\bcommit\s*;$/i);
  });

  it("is additive only: no drop, alter table, truncate, update or delete (outside string literals)", () => {
    const bare = sansStrings(code);
    expect(bare).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view|trigger|schema)\b/i);
    expect(bare).not.toMatch(/\balter\s+table\b/i);
    expect(bare).not.toMatch(/\btruncate\b/i);
    expect(bare).not.toMatch(/\bdelete\s+from\b/i);
    expect(bare).not.toMatch(/\bupdate\s+public\./i);
  });

  it("creates no table, so there is nothing to grant (no anon/authenticated table privileges)", () => {
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+(table|all\s+tables|sequence|schema)\b/i);
  });

  it("reloads the PostgREST schema cache", () => {
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'\s*;/i);
  });
});

describe("129 invalid-index guard", () => {
  it("has a DO block that aborts on an invalid clusters_search_fold_live_idx, before anything is created", () => {
    const doStart = code.search(/\bdo\s+\$guard\$/i);
    expect(doStart).toBeGreaterThan(-1);
    const guard = code.slice(doStart, code.search(/\$guard\$\s*;/i) + 8);
    expect(guard).toContain(INDEX_NAME);
    expect(guard).toMatch(/indisvalid\s*=\s*false/i);
    expect(guard).toMatch(/raise\s+exception/i);
    expect(guard).toMatch(/drop index concurrently/i);
    expect(doStart).toBeLessThan(code.search(/create\s+or\s+replace\s+function/i));
    expect(doStart).toBeLessThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });
});

describe("129 tayf_search_fold(text)", () => {
  it("returns text and is language sql, immutable, parallel safe, empty search_path, not security definer", () => {
    expect(foldFn).toMatch(
      /create\s+or\s+replace\s+function\s+public\.tayf_search_fold\s*\(\s*p_text\s+text\s*\)/i,
    );
    const h = fnHeader(foldFn);
    expect(h).toMatch(/returns\s+text\b/i);
    expect(h).toMatch(/\blanguage\s+sql\b/i);
    expect(h).toMatch(/\bimmutable\b/i);
    expect(h).toMatch(/\bparallel\s+safe\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    expect(h).not.toMatch(/\bsecurity\s+definer\b/i);
    expect(h).not.toMatch(/\b(volatile|stable)\b/i);
  });

  it("body is lower(translate(p_text, FROM || chr(775), TO) collate \"C\"), schema-qualified", () => {
    const b = collapse(fnBody(foldFn));
    const m =
      /^select pg_catalog\.lower\(pg_catalog\.translate\(p_text, '([^']*)' \|\| pg_catalog\.chr\(775\), '([^']*)'\) collate pg_catalog\."C"\)$/.exec(
        b,
      );
    expect(m, `fold body not in the expected shape: ${b}`).not.toBeNull();
    expect(m![1]).toBe(SEARCH_FOLD_FROM);
    expect(m![2]).toBe(SEARCH_FOLD_TO);
  });

  it("chr(775) is U+0307, the combining dot above that translate() deletes (TO is one character shorter than FROM + it)", () => {
    expect(String.fromCodePoint(775)).toBe("̇");
    expect([...SEARCH_FOLD_FROM].length + 1).toBe([...SEARCH_FOLD_TO].length + 1 + 0);
    expect([...SEARCH_FOLD_FROM]).toHaveLength([...SEARCH_FOLD_TO].length);
  });

  it("the SQL fold (emulated) equals the TypeScript foldTr on 20 samples", () => {
    const samples = [
      "İMAMOĞLU",
      "ŞİŞLİ",
      "İSTANBUL",
      "Cumhurbaşkanı",
      "Özgür Özel",
      "Bahçeli",
      "Erdoğan",
      "IŞIK ışık",
      "ÂÎÛ âîû",
      "İstanbul",
      "i̇stanbul",
      "Çankaya Üniversitesi",
      "Gül, ağaç; şöför!",
      "ABC xyz 123",
      "ÉÀÜ",
      "",
      " ",
      '"seçim sonuçları" -x',
      "a\u{1F600}b",
      "İİİİ ıııı",
    ];
    expect(samples).toHaveLength(20);
    for (const s of samples) {
      expect(emulateSqlFold(s), JSON.stringify(s)).toBe(foldTr(s));
    }
  });

  it("is revoked from public/anon/authenticated and granted to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.tayf_search_fold\s*\(\s*text\s*\)\s+from\s+(?=[^;]*\bpublic\b)(?=[^;]*\banon\b)(?=[^;]*\bauthenticated\b)[a-z_,\s]+;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.tayf_search_fold\s*\(\s*text\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+[\w\s,]*on\s+function\s+public\.tayf_search_fold[^;]*to\s+[^;]*\b(anon|authenticated|public)\b/i,
    );
  });
});

describe("129 clusters_search_fold_live_idx", () => {
  it("is a partial GIN index on to_tsvector('turkish', tayf_search_fold(title_tr_neutral || title_tr || summary_tr))", () => {
    const m = /create\s+index\s+if\s+not\s+exists\s+clusters_search_fold_live_idx\s+on\s+public\.clusters\s+using\s+gin\s*\(([\s\S]*?)\)\s*where\s+([^;]+);/i.exec(
      code,
    );
    expect(m, "index statement not found").not.toBeNull();
    expect(collapse(m![2]!)).toBe("not is_archived and article_count >= 2");
    expect(collapse(m![1]!)).toBe(
      "pg_catalog.to_tsvector('pg_catalog.turkish'::pg_catalog.regconfig, public.tayf_search_fold(coalesce(title_tr_neutral, '') || ' ' || coalesce(title_tr, '') || ' ' || coalesce(summary_tr, '')))",
    );
  });

  it("the predicate is the literal 083 live predicate (not is_archived, article_count >= 2)", () => {
    const b = fnBody(searchFn);
    expect(b).toMatch(/not\s+c\.is_archived/i);
    expect(b).toMatch(/c\.article_count\s*>=\s*2\b/i);
  });

  it("the index expression appears verbatim in the RPC body (c. prefixes removed)", () => {
    const m = /using\s+gin\s*\(([\s\S]*?)\)\s*where\s+not\s+is_archived/i.exec(code);
    expect(m).not.toBeNull();
    const expr = collapse(m![1]!);
    const bodyNoAlias = collapse(fnBody(searchFn).replace(/(?<![\w.])c\./g, ""));
    expect(bodyNoAlias).toContain(expr);
  });
});

describe("129 search_cluster_ids(text[], text, integer)", () => {
  it("has the new three-argument signature and is the only definition (no 2-arg overload in 129)", () => {
    expect(searchFn).toMatch(
      /create\s+or\s+replace\s+function\s+public\.search_cluster_ids\s*\(\s*p_variants\s+text\[\]\s*,\s*p_folded\s+text\s*,\s*p_limit\s+integer\s+default\s+12\s*\)/i,
    );
    expect(fnHeader(searchFn)).toMatch(/returns\s+table\s*\(\s*id\s+uuid\s*\)/i);
    const defs = [...code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.search_cluster_ids\b/gi)];
    expect(defs).toHaveLength(1);
    expect(code).not.toMatch(/search_cluster_ids\s*\(\s*p_variants\s+text\[\]\s*,\s*p_limit/i);
  });

  it("is language sql, stable, security definer, empty search_path", () => {
    const h = fnHeader(searchFn);
    expect(h).toMatch(/\blanguage\s+sql\b/i);
    expect(h).toMatch(/\bstable\b/i);
    expect(h).toMatch(/\bsecurity\s+definer\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    expect(h).not.toMatch(/\bvolatile\b/i);
  });

  it("is revoked from public/anon/authenticated and granted to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.search_cluster_ids\s*\(\s*text\[\]\s*,\s*text\s*,\s*integer\s*\)\s+from\s+(?=[^;]*\bpublic\b)(?=[^;]*\banon\b)(?=[^;]*\bauthenticated\b)[a-z_,\s]+;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.search_cluster_ids\s*\(\s*text\[\]\s*,\s*text\s*,\s*integer\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+[\w\s,]*on\s+function\s+public\.search_cluster_ids[^;]*to\s+[^;]*\b(anon|authenticated|public)\b/i,
    );
  });

  it("builds the three 083 websearch_to_tsquery variants and one folded query, matched through scalar subqueries", () => {
    const b = fnBody(searchFn);
    // 083's three OR'd variant queries + the one folded query (inside a lateral, computed once).
    expect([...b.matchAll(/websearch_to_tsquery\s*\(/gi)]).toHaveLength(4);
    expect(b).toMatch(/coalesce\(p_variants\[1\], ''\)/);
    expect(b).toMatch(/coalesce\(p_variants\[2\], p_variants\[1\], ''\)/);
    expect(b).toMatch(/coalesce\(p_variants\[3\], p_variants\[1\], ''\)/);
    expect(b).toMatch(/search_tsv\s*@@\s*\(\s*select\s+qv\s+from\s+q\s*\)/i);
    expect(b).toMatch(/@@\s*\(\s*select\s+qf\s+from\s+q\s*\)/i);
  });

  it("matches the two arms in SEPARATE selects joined by union, never in one OR (a phrase in the variants arm must not recheck the folded expression)", () => {
    const b = fnBody(searchFn);
    const cand = /\bcand\s+as\s*\(([\s\S]*?)\)\s*,\s*top\s+as\b/i.exec(b);
    expect(cand, "cand CTE not found").not.toBeNull();
    // plain UNION (dedups an id that both arms found); UNION ALL would return it twice
    expect(cand![1]).not.toMatch(/\bunion\s+all\b/i);
    const arms = cand![1]!.split(/\bunion\b/i);
    expect(arms).toHaveLength(2);
    expect(arms[0]).toMatch(/search_tsv\s*@@\s*\(\s*select\s+qv\s+from\s+q\s*\)/i);
    expect(arms[0]).not.toMatch(/\bqf\b/);
    expect(arms[1]).toMatch(/@@\s*\(\s*select\s+qf\s+from\s+q\s*\)/i);
    expect(arms[1]).not.toMatch(/search_tsv|\bqv\b/);
    // no OR joins a tsvector match to anything inside either arm's WHERE
    for (const arm of arms) expect(arm.replace(/'[^']*'/g, "''")).not.toMatch(/\bor\b/i);
    // both arms repeat the literal partial-index predicate
    for (const arm of arms) {
      expect(arm).toMatch(/not\s+c\.is_archived/i);
      expect(arm).toMatch(/c\.article_count\s*>=\s*2\b/i);
    }
  });

  it("qf never holds a phrase operator: quotes and letter-hyphen-letter become spaces, a leftover '<' falls back to plainto_tsquery", () => {
    const b = fnBody(searchFn);
    const calls = callArgs(b, "pg_catalog\\.regexp_replace");
    const cleaner = calls.find((args) => args[1]?.includes("(?<=[a-z0-9])-(?=[a-z0-9])"));
    expect(cleaner, "phrase cleaner not found").toBeDefined();
    expect(cleaner![1]).toBe("'\"|(?<=[a-z0-9])-(?=[a-z0-9])'");
    expect(cleaner![2]).toBe("' '");
    expect(cleaner![3]).toBe("'g'");
    const cb = collapse(b);
    expect(cb).toMatch(
      /case when pg_catalog\.strpos\(x\.w::pg_catalog\.text, '<'\) > 0 then pg_catalog\.plainto_tsquery\('pg_catalog\.turkish'::pg_catalog\.regconfig, f\.s\) else x\.w end as qf/,
    );
    // SECURITY DEFINER with search_path '': pg_temp is still searched first
    // for type names, so every cast in the body names pg_catalog explicitly.
    expect(cb.replace(/'[^']*'/g, "''")).not.toMatch(/::(?!pg_catalog\.)[a-z_]/);
    // phraseto_tsquery / an explicit <-> must never be introduced
    expect(b.replace(/'[^']*'/g, "''")).not.toMatch(/phraseto_tsquery|<->/i);
  });

  it("scores only the 1000 most recently updated candidates: a capped `top` between cand and the ranking", () => {
    const b = fnBody(searchFn);
    const cb = collapse(b);
    expect(cb).toContain("select k.id from cand k order by k.updated_at desc, k.id limit 1000");
    // the ranked rows come from `top`, never straight from cand
    expect(cb).toMatch(/from top t join public\.clusters c on c\.id = t\.id/);
    expect(cb).not.toMatch(/from cand\b[^)]*\bts_rank_cd/i);
    // top is defined after cand and before the ranking order by
    expect(b.search(/\bcand\s+as\b/i)).toBeLessThan(b.search(/\btop\s+as\b/i));
    expect(b.search(/\btop\s+as\b/i)).toBeLessThan(b.search(/\bts_rank_cd\b/i));
  });

  it("ranks by a score first (ts_rank_cd, a strpos literal tier, now() recency); article_count only breaks ties", () => {
    const b = fnBody(searchFn);
    // the ranking is the LAST order by (the cap's `order by updated_at desc` comes first)
    const at = b.toLowerCase().lastIndexOf("order by");
    const m = /^order\s+by\b([\s\S]*?)\blimit\b/i.exec(b.slice(at));
    expect(m, "order by not found").not.toBeNull();
    const keys = topLevelSplit(m![1]!);
    const first = keys[0]!;
    expect(first).toMatch(/ts_rank_cd/i);
    expect(first).toMatch(/strpos/i);
    expect(first).toMatch(/now\(\)/i);
    expect(first).toMatch(/\bdesc\s*$/i);
    expect(first).not.toMatch(/article_count/i);
    const rest = keys.slice(1).join(",");
    expect(rest).toMatch(/article_count\s+desc/i);
    expect(keys.findIndex((k) => /article_count/i.test(k))).toBeGreaterThan(0);
    // the remaining tie-breaks stay deterministic
    expect(rest).toMatch(/updated_at\s+desc/i);
    expect(rest).toMatch(/\bh\.id\b/);
  });

  it("names the weights W_REL=1.0, W_LIT=2.0, W_REC=0.5 and W_LIT beats the best W_REL + W_REC", () => {
    expect(headText).toMatch(/W_REL\s*=\s*1\.0/);
    expect(headText).toMatch(/W_LIT\s*=\s*2\.0/);
    expect(headText).toMatch(/W_REC\s*=\s*0\.5/);
    const b = fnBody(searchFn);
    const rel = Number(/([\d.]+)\s*\*\s*pg_catalog\.ts_rank_cd/i.exec(b)?.[1]);
    const lit = Number(/([\d.]+)\s*\*\s*\(\s*case\s+when/i.exec(b)?.[1]);
    const rec = Number(/([\d.]+)\s*\/\s*\(\s*1\.0\s*\+/i.exec(b)?.[1]);
    expect([rel, lit, rec]).toEqual([1.0, 2.0, 0.5]);
    // ts_rank_cd(..., 32) divides by (rank + 1): it stays below 1. Recency is at most W_REC.
    expect(b).toMatch(/ts_rank_cd\([^;]*?,\s*32\s*\)/i);
    expect(lit).toBeGreaterThan(rel * 1 + rec);
    // recency scale: 7 days in seconds.
    expect(b).toMatch(/604800(\.0)?/);
    expect(headText).toMatch(/7 days/i);
  });

  it("keeps the greatest(1, least(coalesce(p_limit, 12), 50)) cap", () => {
    const b = fnBody(searchFn);
    expect(collapse(b)).toContain("greatest(1, least(coalesce(p_limit, 12), 50))");
  });

  it("puts no user text inside a regex pattern: constant patterns only (the query is only ever the subject), strpos for matching", () => {
    const b = fnBody(searchFn);
    const calls = callArgs(b, "pg_catalog\\.regexp_replace");
    expect(calls.length).toBeGreaterThan(0);
    const allowedPatterns = new Set(["'[^a-z0-9]+'", "'\"|(?<=[a-z0-9])-(?=[a-z0-9])'"]);
    for (const args of calls) {
      expect(args).toHaveLength(4);
      expect(allowedPatterns.has(args[1]!), `pattern not a known constant: ${args[1]}`).toBe(true);
      expect(args[2]).toBe("' '");
      expect(args[3]).toBe("'g'");
    }
    expect(b).not.toMatch(/\bsimilar\s+to\b/i);
    expect(b).not.toMatch(/\b(i?like)\b/i);
    expect(b).not.toMatch(/regexp_match(es)?\s*\(/i);
    // no ~ operator at all: pattern matching is regexp_replace on titles + strpos
    expect(b.replace(/'[^']*'/g, "''")).not.toMatch(/~/);
    expect(callArgs(b, "pg_catalog\\.strpos").length).toBeGreaterThan(0);
  });
});

describe("129 header: ORCHESTRATOR PRE-BUILD", () => {
  it("documents Step 0, the local proof, the pre-build, VERIFY and ROLLBACK", () => {
    expect(head).toContain("STEP 0");
    expect(head).toContain("LOCAL PROOF");
    expect(head).toContain("ORCHESTRATOR PRE-BUILD");
    expect(head).toContain("VERIFY");
    expect(head).toContain("ROLLBACK");
  });

  it("records the writer-role check: only postgres and service_role write public.clusters", () => {
    expect(headText).toMatch(/writer/i);
    expect(headText).toMatch(/service_role/);
    expect(headText).toMatch(/postgres/);
    expect(headText).toMatch(/pg_stat_statements/);
    expect(headText).toMatch(/ExecInitFunc|ACL/);
  });

  it("the pre-build CIC statement equals the in-transaction create index with 'concurrently' added", () => {
    const inTx = [...code.matchAll(/create\s+index\s+if\s+not\s+exists\s+clusters_search_fold_live_idx\s+on\s+[^;]+;/gi)];
    expect(inTx).toHaveLength(1);
    const pre = [
      ...headText.matchAll(/create\s+index\s+concurrently\s+if\s+not\s+exists\s+clusters_search_fold_live_idx\s+on\s+[^;]+;/gi),
    ];
    expect(pre).toHaveLength(1);
    const expected = collapse(inTx[0]![0]).replace(
      /^create index if not exists/i,
      "create index concurrently if not exists",
    );
    expect(collapse(pre[0]![0])).toBe(expected);
  });

  it("the pre-build function text equals the in-transaction function", () => {
    const preFn = functionBlock(headText, "tayf_search_fold");
    expect(collapse(preFn)).toBe(collapse(foldFn));
  });

  it("the pre-build revokes and grants like the migration, and creates the function before the index", () => {
    expect(headText).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.tayf_search_fold\s*\(\s*text\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(headText).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.tayf_search_fold\s*\(\s*text\s*\)\s+to\s+service_role\s*;/i,
    );
    const fnAt = headText.search(/create\s+or\s+replace\s+function\s+public\.tayf_search_fold/i);
    const cicAt = headText.search(/create\s+index\s+concurrently\s+if\s+not\s+exists\s+clusters_search_fold_live_idx/i);
    expect(fnAt).toBeGreaterThan(-1);
    expect(cicAt).toBeGreaterThan(fnAt);
    // the function step is one short transaction
    const between = headText.slice(0, cicAt);
    expect(between).toMatch(/\bbegin\s*;[\s\S]*tayf_search_fold[\s\S]*\bcommit\s*;/i);
  });

  it("documents BOUNDED WORK: phrase recheck, the two arms, the 1000-candidate cap, and why there is no limiter here", () => {
    expect(headText).toContain("BOUNDED WORK");
    expect(headText).toMatch(/phrase recheck/i);
    expect(headText).toMatch(/UNION/);
    expect(headText).toMatch(/1000 most recently updated/);
    expect(headText).toMatch(/process-local/);
  });

  it("WRITE COST says every non-HOT update of a live cluster maintains the index (article_count, updated_at), never that they skip it", () => {
    const at = headText.indexOf("WRITE COST.");
    expect(at, "WRITE COST paragraph not found").toBeGreaterThan(-1);
    const para = headText.slice(at, headText.indexOf("VERIFY (read-only", at));
    expect(para).toMatch(/EVERY non-HOT update/);
    expect(para).toMatch(/article_count/);
    expect(para).toMatch(/updated_at/);
    expect(para).toMatch(/permission denied for function tayf_search_fold/);
    expect(para).not.toMatch(/are not index columns/i);
    expect(para).not.toMatch(/does not touch it/i);
  });

  it("VERIFY compares the cluster update cost before and after (pg_stat_statements mean_exec_time on update public.clusters)", () => {
    const at = headText.indexOf("VERIFY (read-only");
    const verify = headText.slice(at, headText.search(/^ROLLBACK \(/m));
    expect(verify).toMatch(/mean_exec_time/);
    expect(verify).toMatch(/update %clusters%/);
    expect(verify).toMatch(/BEFORE the\s+pre-build/);
  });

  it("has the invalid-index check query for the operator (expect 0 rows)", () => {
    expect(headText).toMatch(
      /select\s+c\.relname\s+from\s+pg_catalog\.pg_index\s+i\s+join\s+pg_catalog\.pg_class\s+c\s+on\s+c\.oid\s*=\s*i\.indexrelid\s+where\s+c\.relname\s*=\s*'clusters_search_fold_live_idx'\s+and\s+not\s+i\.indisvalid\s*;/i,
    );
  });

  it("ROLLBACK drops the 3-arg function, the index concurrently, the fold function and the ledger row", () => {
    const rbAt = headText.search(/^ROLLBACK \(/m);
    expect(rbAt, "ROLLBACK heading not found").toBeGreaterThan(-1);
    const rb = headText.slice(rbAt);
    expect(rb).toMatch(/drop\s+function\s+if\s+exists\s+public\.search_cluster_ids\s*\(\s*text\[\]\s*,\s*text\s*,\s*integer\s*\)/i);
    expect(rb).toMatch(/drop\s+index\s+concurrently\s+if\s+exists\s+clusters_search_fold_live_idx/i);
    expect(rb).toMatch(/drop\s+function\s+if\s+exists\s+public\.tayf_search_fold\s*\(\s*text\s*\)/i);
    expect(rb).toMatch(/delete\s+from\s+supabase_migrations\.schema_migrations\s+where\s+version\s*=\s*'129'/i);
    // order: function (index dependency) goes after the index
    expect(rb.search(/drop\s+index\s+concurrently/i)).toBeLessThan(
      rb.search(/drop\s+function\s+if\s+exists\s+public\.tayf_search_fold/i),
    );
  });
});

describe("129 callers", () => {
  it("search-query.ts passes p_folded and keeps the p_variants contract", () => {
    const src = readFileSync(SEARCH_QUERY_TS, "utf8");
    expect(src).toMatch(/\.rpc\(\s*"search_cluster_ids"\s*,\s*\{[\s\S]*?p_variants[\s\S]*?p_folded/);
    expect(src).toContain("p_folded");
  });
});
