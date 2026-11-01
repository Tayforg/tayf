import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BIAS_TO_ZONE,
  BLINDSPOT,
} from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";
import { RECALL_VETO_MIN_PROB } from "../../src/lib/clusters/recall-veto";
import {
  RISING_FOLD_FROM,
  RISING_FOLD_TO,
} from "../../src/lib/trends/rising-entities";
import {
  SIBLING_VETO,
  siblingTitleTokens,
  siblingTitlesMatch,
} from "../../src/lib/clusters/sibling-veto";

// Migration 126 extends the blindspot veto of 071: a "kor nokta" is also
// withdrawn when a live, near-identical sibling cluster (title tokens, 24 h)
// carries the silent side. The SQL holds hand-written copies of the zone map,
// the BLINDSPOT thresholds, the voting kinds, the Turkish fold strings and the
// sibling thresholds in src/lib/clusters/sibling-veto.ts. This file fails the
// build the moment any copy drifts, and pins the safety properties of the
// definer function. The behaviour itself is exercised by
// tests/migrations/sql/126-blindspot-sibling-veto-dryrun.sql on a local PG15.

const MIGRATIONS = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS, "126_blindspot_sibling_veto.sql");
const MIGRATION_071 = resolve(MIGRATIONS, "071_blindspot_recall_veto.sql");

// md5(prosrc) of public.blindspot_recall_veto_refresh on production before 126
// (read-only, 2026-11-01); equal to the md5 of 071's function body text.
const PROD_MD5_BEFORE = "ee3a003fa0225da3bbb22a3fbb7da1b0";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

type Span = { begin: number; commit: number };

// Explicit `begin;` ... `commit;` blocks of the file (line-anchored, so the
// plpgsql `begin` keywords inside $$ bodies never match).
function transactionSpans(sql: string): Span[] {
  const marks = [...sql.matchAll(/^\s*(begin|commit)\s*;/gim)].map((m) => ({
    kind: (m[1] as string).toLowerCase(),
    at: m.index as number,
  }));
  const spans: Span[] = [];
  let open: number | null = null;
  for (const m of marks) {
    if (m.kind === "begin") {
      expect(open).toBeNull();
      open = m.at;
    } else {
      expect(open).not.toBeNull();
      spans.push({ begin: open as number, commit: m.at });
      open = null;
    }
  }
  expect(open).toBeNull();
  return spans;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let sql = "";
let code = "";
beforeAll(() => {
  // A missing migration fails each assertion below instead of the whole file,
  // so the pure title-matching tests stay runnable on their own.
  sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";
  code = stripSqlComments(sql);
});

describe("sibling title matching (src/lib/clusters/sibling-veto.ts)", () => {
  it("pins the thresholds the SQL copies", () => {
    expect(SIBLING_VETO).toEqual({
      minJaccard: 0.5,
      minShared: 3,
      windowHours: 24,
      scopeHours: 48,
      tokenMinLen: 4,
      stemLen: 5,
    });
  });

  it("the 112a68bd twin: four shared stems, Jaccard 0.8, matches", () => {
    const a = "Erdoğan ve Zelenskiy İstanbul'da görüştü";
    const b = "Cumhurbaşkanı Erdoğan, Zelenski ile İstanbul'da görüştü";
    const ta = siblingTitleTokens(a);
    const tb = siblingTitleTokens(b);
    expect([...ta].sort()).toEqual(["erdog", "gorus", "istan", "zelen"]);
    expect([...tb].sort()).toEqual(["cumhu", "erdog", "gorus", "istan", "zelen"]);
    const shared = [...ta].filter((t) => tb.has(t)).length;
    expect(shared).toBe(4);
    expect(shared / (ta.size + tb.size - shared)).toBeCloseTo(0.8, 10);
    expect(siblingTitlesMatch(a, b)).toBe(true);
    expect(siblingTitlesMatch(b, a)).toBe(true);
  });

  it("two stories about the same people but different events do not match", () => {
    expect(
      siblingTitlesMatch(
        "Cumhurbaşkanı Erdoğan Zelenski görüşmesi sona erdi",
        "Ukrayna Devlet Başkanı Zelenski İstanbul'a geldi",
      ),
    ).toBe(false);
  });

  it("folds Turkish letters to ASCII, lowercases, drops short words and stems to five characters", () => {
    expect([...siblingTitleTokens("İSTANBUL Ğüzel ÖĞRENCİ çÂlışma ve ile 2026")].sort()).toEqual([
      "2026",
      "calis",
      "guzel",
      "istan",
      "ogren",
    ]);
  });

  it("a Set: repeated words and words sharing a five-character stem count once", () => {
    const t = siblingTitleTokens("Meclis meclisi Meclis'te toplandı toplantı");
    expect([...t].sort()).toEqual(["mecli", "topla"]);
  });

  it("needs three shared stems and Jaccard 0.5, both inclusive", () => {
    // 3 shared of union 6 -> exactly 0.5 and exactly 3: matches.
    expect(siblingTitlesMatch("alfa bravo carlo delta", "alfa bravo carlo echos foxtrot")).toBe(true);
    // 3 shared of union 7 -> 0.43: no.
    expect(siblingTitlesMatch("alfa bravo carlo delta echos", "alfa bravo carlo golfs hotel")).toBe(false);
    // 2 shared, Jaccard 1.0: below the shared floor.
    expect(siblingTitlesMatch("alfa bravo", "alfa bravo")).toBe(false);
    // 2 shared of union 4 = 0.5 but only two shared.
    expect(siblingTitlesMatch("alfa bravo carlo", "alfa bravo delta")).toBe(false);
    // Identical 3-token titles: 3 shared, Jaccard 1.
    expect(siblingTitlesMatch("alfa bravo carlo", "carlo bravo alfa")).toBe(true);
  });

  it("empty, null and undefined titles never match anything", () => {
    expect(siblingTitleTokens("").size).toBe(0);
    expect(siblingTitleTokens(null).size).toBe(0);
    expect(siblingTitleTokens(undefined).size).toBe(0);
    expect(siblingTitlesMatch("", "")).toBe(false);
    expect(siblingTitlesMatch(null, "alfa bravo carlo")).toBe(false);
    expect(siblingTitlesMatch("alfa bravo carlo", undefined)).toBe(false);
  });

  it("ignores punctuation, digits stay, emoji and symbols are separators", () => {
    const t = siblingTitleTokens("Dolar 38,50'yi aştı 🚀 #dolar");
    expect([...t].sort()).toEqual(["asti", "dolar"]);
  });

  it("handles a very long title without throwing", () => {
    const long = Array.from({ length: 5000 }, (_, i) => `w${i}abc`).join(" ");
    expect(siblingTitleTokens(long).size).toBe(5000);
  });
});

describe("126 header and bookkeeping", () => {
  it("the header md5 is the md5 of 071's function body, which production runs", () => {
    const body = /\$fn\$([\s\S]*?)\$fn\$/.exec(readFileSync(MIGRATION_071, "utf8"));
    expect(body).not.toBeNull();
    expect(createHash("md5").update((body as RegExpExecArray)[1] as string).digest("hex")).toBe(
      PROD_MD5_BEFORE,
    );
    const header = sql.slice(0, sql.search(/^begin;/m));
    expect(header).toMatch(/\b[0-9a-f]{32}\b/);
    expect(header).toContain(PROD_MD5_BEFORE);
  });

  it("the header records the reader grep, the deploy order and the rollback", () => {
    const header = sql.slice(0, sql.search(/^begin;/m));
    expect(header).toMatch(/DEPLOY ORDER/);
    expect(header).toMatch(/ROLLBACK/i);
    expect(header).toMatch(/rg -n is_blindspot/);
  });

  it("is additive: no drop, delete or truncate", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|function|index|constraint)\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|truncate)\b/i);
  });

  it("is a sequence of short transactions: the ACCESS EXCLUSIVE ALTER commits before any slow statement", () => {
    // ALTER TABLE ... ADD COLUMN holds ACCESS EXCLUSIVE on public.clusters until
    // its transaction ends; lock_timeout only limits the wait for the lock, not
    // how long it is held. So VALIDATE (a full scan) and the 6-10 s backfill must
    // not share a transaction with it.
    const txs = transactionSpans(code);
    expect(txs.length).toBeGreaterThanOrEqual(2);
    const add = code.search(/alter\s+table\s+public\.clusters\s+add\s+column\b/i);
    const validate = code.search(/alter\s+table\s+public\.clusters\s+validate\s+constraint\b/i);
    const backfill = code.search(/\bdo\s+\$backfill\$/i);
    const lockTimeout = code.search(/set\s+local\s+lock_timeout\s*=\s*'5s'/i);
    expect([add, validate, backfill, lockTimeout].every((i) => i >= 0)).toBe(true);

    const addTx = txs.find((t) => add > t.begin && add < t.commit);
    expect(addTx).toBeDefined();
    // the ADD COLUMN transaction carries the lock timeout and nothing slow
    expect(lockTimeout).toBeGreaterThan((addTx as Span).begin);
    expect(lockTimeout).toBeLessThan(add);
    expect(validate).toBeGreaterThan((addTx as Span).commit);
    expect(backfill).toBeGreaterThan((addTx as Span).commit);

    // VALIDATE (SHARE UPDATE EXCLUSIVE) and the backfill (row locks) run outside
    // any explicit transaction block that could hold a table lock on clusters.
    expect(txs.some((t) => validate > t.begin && validate < t.commit)).toBe(false);
    expect(txs.some((t) => backfill > t.begin && backfill < t.commit)).toBe(false);
    // no transaction holds two heavy things at once
    for (const t of txs) {
      const body = code.slice(t.begin, t.commit);
      expect(/validate\s+constraint/i.test(body) && /add\s+column/i.test(body)).toBe(false);
      expect(/blindspot_recall_veto_refresh\(\s*interval\s+'7 days'/i.test(body)).toBe(false);
    }
  });

  it("every begin is closed by a commit, in order", () => {
    const begins = [...code.matchAll(/^\s*begin\s*;/gim)].length;
    const commits = [...code.matchAll(/^\s*commit\s*;/gim)].length;
    expect(begins).toBeGreaterThanOrEqual(2);
    expect(commits).toBe(begins);
    expect(transactionSpans(code)).toHaveLength(begins);
  });

  it("adds clusters.blindspot_veto_reason with a CHECK that allows only 'jev_recall' and 'sibling_headline'", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.clusters\s+add\s+column\s+if\s+not\s+exists\s+blindspot_veto_reason\s+text\s*;/i,
    );
    const m =
      /add\s+constraint\s+clusters_blindspot_veto_reason_check\s+check\s*\(\s*blindspot_veto_reason\s+in\s*\(([^)]*)\)\s*\)/i.exec(
        code,
      );
    expect(m).not.toBeNull();
    const allowed = [...((m as RegExpExecArray)[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(allowed).toEqual(["jev_recall", "sibling_headline"]);
    expect(code).toMatch(/comment\s+on\s+column\s+public\.clusters\.blindspot_veto_reason\s+is/i);
  });

  it("adds the CHECK NOT VALID and validates it: an inline CHECK on ADD COLUMN would scan clusters under ACCESS EXCLUSIVE", () => {
    // 099's pattern: guarded add constraint ... not valid, then validate constraint.
    expect(code).toMatch(/check\s*\([^;]*?\)\s*not\s+valid\s*;/i);
    expect(code).toMatch(
      /alter\s+table\s+public\.clusters\s+validate\s+constraint\s+clusters_blindspot_veto_reason_check\s*;/i,
    );
    expect(code).not.toMatch(/add\s+column[^;]*\bcheck\b/i);
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'/i);
  });

  it("emits only those two reasons, Jev first", () => {
    expect(code).toMatch(
      /case\s+when\s+\w+\.veto_jev\s+then\s+'jev_recall'\s+when\s+\w+\.veto_sib\s+then\s+'sibling_headline'\s+end/i,
    );
  });

  it("backfills exactly once with a 7-day window, and never lets a skipped run pass as a finished one", () => {
    const calls = [...code.matchAll(/blindspot_recall_veto_refresh\(\s*interval\s+'7 days'\s*\)\s*;/gi)];
    expect(calls).toHaveLength(1);
    const block = /do\s+\$backfill\$([\s\S]*?)\$backfill\$\s*;/i.exec(code);
    expect(block).not.toBeNull();
    const body = (block as RegExpExecArray)[1] as string;
    // The function returns 0 when it cannot take its advisory lock. The block
    // takes the same lock first (re-entrant in one session), retries, and fails
    // loudly instead of recording the migration with the backfill undone.
    const fnKey = /pg_try_advisory_xact_lock\(\s*pg_catalog\.hashtext\('([a-z_]+)'\)::bigint\s*\)/.exec(
      code.slice(0, code.indexOf("$backfill$")),
    );
    expect(fnKey).not.toBeNull();
    expect(body).toContain(`hashtext('${(fnKey as RegExpExecArray)[1]}')`);
    expect(body).toMatch(/pg_try_advisory_xact_lock\(/);
    expect(body).toMatch(/pg_sleep\(/);
    expect(body).toMatch(/raise\s+exception\b/i);
    expect(body).toMatch(/:=\s*public\.blindspot_recall_veto_refresh\(\s*interval\s+'7 days'\s*\)/i);
    expect(body).toMatch(/raise\s+notice\b/i);
    // lock first, then the call
    expect(body.search(/pg_try_advisory_xact_lock\(/)).toBeLessThan(body.search(/:=\s*public\./));
  });

  it("inserts the ledger row after the backfill, outside any transaction block", () => {
    const insert = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(insert).toBeGreaterThan(code.search(/\$backfill\$\s*;/i));
    expect(transactionSpans(code).some((t) => insert > t.begin && insert < t.commit)).toBe(false);
  });

  it("records itself as version '126' with the 095 insert pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'126'\s*,\s*'126_blindspot_sibling_veto'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;/i,
    );
  });

  it("never touches cron: the 071 schedule keeps running the replaced function", () => {
    expect(code).not.toMatch(/cron\.(un)?schedule/i);
    expect(code).not.toMatch(/pg_cron/i);
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });
});

describe("126 parity with the bias-zone contract", () => {
  it("the zmap VALUES pairs deep-equal BIAS_TO_ZONE", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*\n?\s*win\s+as/i.exec(
      code,
    );
    expect(span).not.toBeNull();
    const body = (span as RegExpExecArray)[1] as string;
    const parsed: Record<string, string> = {};
    const pairRe = /\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = pairRe.exec(body)) !== null) {
      parsed[m[1] as string] = m[2] as string;
      count += 1;
    }
    expect(count).toBe(Object.keys(BIAS_TO_ZONE).length);
    expect(parsed).toEqual({ ...BIAS_TO_ZONE });
  });

  it("the live contract uses BLINDSPOT.minSources and BLINDSPOT.dominantShare", () => {
    const share = escapeRe(String(BLINDSPOT.dominantShare));
    expect(code).toMatch(new RegExp(`l\\.tot\\s*>=\\s*${BLINDSPOT.minSources}\\b`));
    expect(code).toMatch(
      new RegExp(`l\\.dom_n::numeric\\s*/\\s*nullif\\(l\\.tot,\\s*0\\)\\s*>=\\s*${share}\\b`),
    );
  });

  it("both vetoes fire when an adjusted dominant share drops below BLINDSPOT.dominantShare", () => {
    const share = escapeRe(String(BLINDSPOT.dominantShare));
    const below = [
      ...code.matchAll(
        new RegExp(`\\w+\\.dom_n::numeric\\s*/\\s*nullif\\(\\w+\\.tot,\\s*0\\)\\s*<\\s*${share}\\b`, "g"),
      ),
    ];
    // adj_jev (071 logic) and adj_all (Jev plus siblings).
    expect(below.length).toBeGreaterThanOrEqual(2);
  });

  it("every voting-kind list equals VOTING_SOURCE_KINDS (Jev path and sibling path)", () => {
    const lists = [...code.matchAll(/\bkind\s+in\s*\(([^)]+)\)/gi)];
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const m of lists) {
      const kinds = [...(m[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      expect(new Set(kinds)).toEqual(new Set(VOTING_SOURCE_KINDS));
    }
  });

  it("reads only blindspot_recall predictions at the RECALL_VETO_MIN_PROB default, and never goes below 0.5", () => {
    expect(code).toMatch(/p\.task\s*=\s*'blindspot_recall'/);
    const p = escapeRe(String(RECALL_VETO_MIN_PROB));
    expect(code).toMatch(new RegExp(`p_min_prob\\s+numeric\\s+default\\s+${p}\\b`, "i"));
    expect(code).toMatch(
      new RegExp(`greatest\\(\\s*coalesce\\(\\s*p_min_prob\\s*,\\s*${p}\\s*\\)\\s*,\\s*0\\.5\\s*\\)`, "i"),
    );
  });

  it("never double-counts: Jev and sibling voters that are already members are excluded", () => {
    // Jev path: 071 verbatim. Sibling path: the same test against wmem, the
    // (cluster, source) pairs of the scope's members (a hash anti-join over all
    // of cluster_articles x articles cost seconds on production).
    expect(code).toMatch(/not\s+exists\s*\(\s*select\s+1\s+from\s+public\.cluster_articles/i);
    expect(code).toMatch(/not\s+exists\s*\(\s*select\s+1\s+from\s+wmem\b/i);
    const guards = [
      ...code.matchAll(/not\s+exists\s*\(\s*select\s+1\s+from\s+(?:public\.cluster_articles|wmem)\b/gi),
    ];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    // wmem is built from the members of the scope, every article of each, tokens or not.
    expect(code).toMatch(/wmem\s+as\s*\(\s*select\s+distinct\s+cluster_id\s*,\s*source_id\s+from\s+wart\s*\)/i);
  });

  it("the translate() literals equal RISING_FOLD_FROM / RISING_FOLD_TO, wherever titles are tokenised", () => {
    const folds = [
      ...code.matchAll(
        /translate\(\s*coalesce\(\s*a\.title\s*,\s*''\s*\)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g,
      ),
    ];
    // the member side and the sibling side
    expect(folds.length).toBeGreaterThanOrEqual(2);
    for (const m of folds) {
      expect(m[1]).toBe(RISING_FOLD_FROM);
      expect(m[2]).toBe(RISING_FOLD_TO);
    }
  });
});

describe("126 parity with SIBLING_VETO", () => {
  it("tokenises exactly like siblingTitleTokens: length >= tokenMinLen, left(..., stemLen), split on non-alphanumerics", () => {
    expect(code).toMatch(new RegExp(`length\\(\\s*\\w+\\s*\\)\\s*>=\\s*${SIBLING_VETO.tokenMinLen}\\b`));
    expect(code).toMatch(new RegExp(`left\\(\\s*\\w+\\s*,\\s*${SIBLING_VETO.stemLen}\\s*\\)`));
    expect(code).toMatch(/regexp_split_to_table\([\s\S]*?'\[\^a-z0-9\]\+'\s*\)/);
    expect(code).toMatch(/pg_catalog\.lower\(\s*pg_catalog\.translate\(/);
  });

  it("a pair needs minShared shared stems and Jaccard minJaccard within windowHours", () => {
    expect(code).toMatch(new RegExp(`count\\(\\*\\)\\s*>=\\s*${SIBLING_VETO.minShared}\\b`));
    expect(code).toMatch(
      new RegExp(
        `count\\(\\*\\)::numeric\\s*/\\s*\\(\\s*\\w+\\.ntok\\s*\\+\\s*\\w+\\.ntok\\s*-\\s*(?:pg_catalog\\.)?count\\(\\*\\)\\s*\\)\\s*>=\\s*${escapeRe(String(SIBLING_VETO.minJaccard))}\\b`,
      ),
    );
    expect(code).toMatch(new RegExp(`interval\\s+'${SIBLING_VETO.windowHours} hours'`));
  });

  it("the sibling scope is scopeHours, widened to p_since", () => {
    expect(code).toMatch(
      new RegExp(`v_scope\\s+interval\\s*:=\\s*greatest\\(\\s*interval\\s+'${SIBLING_VETO.scopeHours} hours'\\s*,\\s*v_since\\s*\\)`),
    );
  });

  it("sibling clusters must be live: not archived, not merged", () => {
    expect(code).toMatch(/\bis_archived\b/);
    expect(code).toMatch(/\bmerged_into\s+is\s+null\b/i);
  });

  it("evidence older than the scope is frozen by the stored reason, not recomputed", () => {
    expect(code).toMatch(/blindspot_veto_reason\s*=\s*'sibling_headline'/);
    expect(code).toMatch(/created_at\s*<\s*pg_catalog\.now\(\)\s*-\s*v_scope/);
  });
});

describe("126 function safety", () => {
  it("replaces blindspot_recall_veto_refresh with the 071 signature and defaults", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.blindspot_recall_veto_refresh\s*\(\s*p_since\s+interval\s+default\s+interval\s+'26 hours'\s*,\s*p_min_prob\s+numeric\s+default\s+0\.85\s*\)\s*returns\s+integer/i,
    );
  });

  it("is SECURITY DEFINER with an empty search_path", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.blindspot_recall_veto_refresh\s*\([\s\S]*?\)\s*returns\s+integer\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
    );
  });

  it("revokes execute from public/anon/authenticated and grants it only to service_role, with no other GRANT", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.blindspot_recall_veto_refresh\(interval,\s*numeric\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.blindspot_recall_veto_refresh\(interval,\s*numeric\)\s+to\s+service_role\s*;/i,
    );
    const grants = [...code.matchAll(/\bgrant\b/gi)];
    expect(grants).toHaveLength(1);
    expect(code).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });

  it("serialises concurrent runs with the 071 transaction advisory lock", () => {
    expect(code).toMatch(/pg_catalog\.pg_try_advisory_xact_lock\(\s*pg_catalog\.hashtext\('blindspot_recall_veto_refresh'\)::bigint\s*\)/);
  });

  it("the single UPDATE is idempotent: is distinct from guards on both veto and reason", () => {
    const updates = [...code.matchAll(/\bupdate\s+public\.\w+/gi)];
    expect(updates).toHaveLength(1);
    expect(code).toMatch(/c\.blindspot_recall_veto\s+is\s+distinct\s+from\s+v\.veto/i);
    expect(code).toMatch(/c\.blindspot_veto_reason\s+is\s+distinct\s+from\s+v\.reason/i);
  });

  it("the UPDATE's set list is exactly the three veto columns", () => {
    const m = /update\s+public\.clusters\s+c\s+set([\s\S]*?)\bfrom\s+verdict\b/i.exec(code);
    expect(m).not.toBeNull();
    const setList = (m as RegExpExecArray)[1] as string;
    const assigned = [...setList.matchAll(/(\w+)\s*=(?!=)/g)].map((x) => x[1]);
    expect(assigned).toEqual([
      "blindspot_recall_veto",
      "blindspot_recall_veto_at",
      "blindspot_veto_reason",
    ]);
    for (const forbidden of ["is_blindspot", "blindspot_side", "updated_at"]) {
      expect(setList).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("only the one function is touched: no other create function, no trigger, no policy", () => {
    expect([...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect(code).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(trigger|policy|view|table|extension)\b/i);
  });
});
