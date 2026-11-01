import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_KEYS, BLINDSPOT } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 132 ("legacy-bias-range-tools").
//
// Hunt 10, finding h10-data-1: 034 re-derived clusters.bias_distribution for
// the last 48 hours only, so every older cluster still counts aggregator and
// niche votes. 215 old clusters carry a public "Kör nokta" flag that fails the
// rule the page itself prints ("Spektrum 5 kaynaktan" next to "spektruma
// sayılmaz"). 132 ships OPERATOR TOOLS, not a backfill: three service_role-only
// functions that write nothing unless an operator calls a writer with
// p_dry_run => false, one window of at most 31 days at a time.
//
// This file pins:
//   * the migration is additive, one transaction, exactly three
//     create or replace function statements, no top-level data statement, the
//     095 ledger row as the last statement;
//   * the three signatures and attributes, the service_role-only ACL;
//   * the writers' guards (dry run by default, bad window, 31-day clamp,
//     advisory lock) and that each has exactly ONE update, inside
//     `if not v_dry_run`, whose WHERE repeats the window on the target row;
//   * the whole file contains exactly two data `set` clauses, so it never
//     writes updated_at, never sets is_blindspot true and never touches the
//     recall-veto columns;
//   * the rule literals (5 voters, 0.8 share, voting kinds) against the
//     contract modules, and the documentation the operator needs;
//   * the script and the runbook call the functions by these names.
// The last block (opt-in, TAYF_PSQL) runs the functions against fixtures in
// rolled-back transactions on a throwaway Postgres with 132 applied.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION_132 = resolve(ROOT, "supabase", "migrations", "132_legacy_bias_range_tools.sql");
const LIB_PATH = resolve(ROOT, "scripts", "lib", "recompute-legacy-bias.mjs");
const GUIDE_PATH = resolve(ROOT, "docs", "migration-guide.md");

const HELPER = "legacy_bias_voter_dists";
const RECOMPUTE = "recompute_bias_distribution_range";
const CLEAR = "clear_false_blindspots_range";

const SIG = {
  [HELPER]: `public.${HELPER}(timestamptz, timestamptz)`,
  [RECOMPUTE]: `public.${RECOMPUTE}(timestamptz, timestamptz, boolean)`,
  [CLEAR]: `public.${CLEAR}(timestamptz, timestamptz, boolean)`,
} as const;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Comment-free, whitespace-collapsed form, for order and preservation checks. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/** `( x )` -> `(x)`: layout-insensitive comparison of a signature. */
function tight(s: string): string {
  return s.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

/** The `create [or replace] function public.<name>(...) ... as $fn$ ... $fn$;` block. */
function fnBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\bas\\s+\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
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

/** Only the SQL between the $fn$ quotes. */
function fnBody(block: string): string {
  const m = block.match(/\bas\s+\$fn\$([\s\S]*?)\$fn\$/i);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** The `'a', 'b'` items of an `in (...)` list that follows `anchor`. */
function inList(sql: string, anchor: RegExp): string[] {
  const m = new RegExp(`${anchor.source}\\s+in\\s*\\(([^)]*)\\)`, anchor.flags.replace("g", "")).exec(sql);
  if (!m) throw new Error(`no in-list after ${anchor}`);
  return [...(m[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string);
}

let sql = "";
let code = "";
let head = "";
let tx = ""; // the raw file after `begin;` (header comments quote function names)
let outside = ""; // code with every $fn$ body emptied, strings blanked
const blocks: Record<string, string> = {};
const bodies: Record<string, string> = {}; // comment-free, normalised, tight
const bodiesBlank: Record<string, string> = {}; // ... with strings blanked
const heads: Record<string, string> = {}; // normalised signature + attributes

beforeAll(() => {
  expect(existsSync(MIGRATION_132), "132_legacy_bias_range_tools.sql must exist").toBe(true);
  sql = readFileSync(MIGRATION_132, "utf8");
  code = stripSqlComments(sql);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  tx = sql.slice(sql.search(/^\s*begin\s*;/im));
  outside = sansStrings(code.replace(/\$fn\$[\s\S]*?\$fn\$/g, () => "$fn$ $fn$"));
  for (const name of [HELPER, RECOMPUTE, CLEAR]) {
    blocks[name] = fnBlock(tx, name);
    const blockCode = fnBlock(code, name);
    bodies[name] = tight(norm(fnBody(blockCode)));
    bodiesBlank[name] = sansStrings(bodies[name] as string);
    heads[name] = tight(norm(header(blockCode)));
  }
});

describe("132 ledger, structure and header", () => {
  it("is one transaction: begin, set local lock_timeout = '5s', ..., ledger insert, commit", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(code).toMatch(/begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
  });

  it("records itself as version '132' in the 095 pattern, as the last statement before commit", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'132'\s*,\s*'132_legacy_bias_range_tools'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
    // nothing but the ledger insert sits between it and commit: its own `;` and commit's
    const after = code.slice(code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i));
    expect([...after.matchAll(/;/g)]).toHaveLength(2);
  });

  it("sanity: comment stripping and string blanking are non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(sql).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
    expect(outside.length).toBeLessThan(code.length);
  });

  it("runs per function in the order function, comment, revoke, grant, and the ledger last", () => {
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    for (const name of [HELPER, RECOMPUTE, CLEAR]) {
      const fn = code.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\b`, "i"));
      const comment = code.search(new RegExp(`comment\\s+on\\s+function\\s+public\\.${name}\\b`, "i"));
      const revoke = code.search(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\b`, "i"));
      const grant = code.search(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\b`, "i"));
      expect(fn, `${name} created`).toBeGreaterThan(0);
      expect(comment, `${name} comment`).toBeGreaterThan(fn);
      expect(revoke, `${name} revoke`).toBeGreaterThan(comment);
      expect(grant, `${name} grant`).toBeGreaterThan(revoke);
      expect(ledger, `${name} before ledger`).toBeGreaterThan(grant);
    }
  });

  it("the header documents WHY, WHAT CHANGES, STEP 0, DRY RUNS, DEPLOY, VERIFY and ROLLBACK", () => {
    for (const section of ["WHY", "h10-data-1", "WHAT CHANGES", "STEP 0", "DRY RUNS", "DEPLOY", "VERIFY", "ROLLBACK"]) {
      expect(head, section).toContain(section);
    }
    expect(head).toMatch(/safe to re-apply/i);
    expect(head).toMatch(/INSERT 0 0/);
    expect(head).toMatch(/dry[- ]run by default|dry run by default/i);
  });

  it("Step 0 records the free version, the missing functions, the trigger count, min(updated_at) and the real counts", () => {
    expect(head).toMatch(/Version 132 is free/i);
    expect(head).toMatch(/tgisinternal/);
    expect(head).toMatch(/min\(updated_at\)/);
    expect(head).toMatch(/EXPLAIN ANALYZE/);
    for (const word of ["scanned", "would_change", "would_clear", "would_newly_flag", "would_go_to_zero_total"]) {
      expect(head, word).toContain(word);
    }
    // the measured production numbers (2026-11-01, updated_at < 2026-09-05)
    for (const n of ["182,778", "66,494", "57,278", "215", "153", "330"]) expect(head, n).toContain(n);
    expect(head).toMatch(/sbq\.py/);
  });

  it("the header explains why there is no statement_timeout (PostgREST's 8 s) and the 57014 fallback", () => {
    expect(head).toMatch(/statement_timeout/);
    expect(head).toMatch(/8 s/);
    expect(head).toMatch(/PostgREST/);
    expect(head).toMatch(/57014/);
    expect(code).not.toMatch(/statement_timeout/i);
  });

  it("documents that the migration backfills nothing and a dry run writes nothing", () => {
    expect(head).toMatch(/backfills nothing/i);
    expect(head).toMatch(/writes? nothing/i);
  });

  it("the header verifies the privileges with has_function_privilege (anon f, authenticated f, service_role t)", () => {
    expect(head).toMatch(/has_function_privilege/);
    expect(head).toMatch(/f, f, t|f,\s*f,\s*t/);
  });

  it("rolls back with `drop function if exists ...` for all three, in comments only", () => {
    for (const name of [HELPER, RECOMPUTE, CLEAR]) {
      expect(head, name).toMatch(new RegExp(`drop function if exists public\\.${name}\\(`));
    }
    expect(head).toMatch(/schema_migrations where version = '132'/);
    expect(code).not.toMatch(/\bdrop\b/i);
  });

  it("the VERIFY md5 and length are those of each function text between the fn quotes", () => {
    for (const name of [HELPER, RECOMPUTE, CLEAR]) {
      const raw = fnBody(blocks[name] as string);
      expect(head, `${name} md5`).toContain(md5(raw));
      expect(head, `${name} length`).toContain(String(raw.length));
    }
  });
});

describe("132 additive shape", () => {
  it("never drops anything (a drop strips the grants and breaks in-flight callers)", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
  });

  it("creates no table, index, trigger or view, alters nothing, schedules nothing", () => {
    expect(code).not.toMatch(/\bcreate\s+(unique\s+)?(table|index|trigger|view|extension|schema|type)\b/i);
    expect(code).not.toMatch(/\balter\b/i);
    expect(code).not.toMatch(/\bcron\./i);
    expect(code).not.toMatch(/\b(vacuum|analyze|truncate)\b/i);
  });

  it("creates exactly three functions, all with create or replace, in the documented order", () => {
    const creates = [...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\s+([a-z_.]+)/gi)];
    expect(creates.map((m) => m[2])).toEqual([`public.${HELPER}`, `public.${RECOMPUTE}`, `public.${CLEAR}`]);
    for (const m of creates) expect(m[1], `${m[2]} uses or replace`).toBeTruthy();
  });

  it("has no select or perform outside a function body: applying the file runs nothing", () => {
    expect(outside).not.toMatch(/\bselect\b/i);
    expect(outside).not.toMatch(/\bperform\b/i);
    expect(outside).not.toMatch(/\b(update|delete|truncate)\b/i);
    expect([...outside.matchAll(/\binsert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual([
      "supabase_migrations.schema_migrations",
    ]);
    // no call of any of the three functions at top level
    for (const name of [HELPER, RECOMPUTE, CLEAR]) {
      const calls = [...outside.matchAll(new RegExp(`\\b${name}\\s*\\(`, "gi"))];
      const decl = [...outside.matchAll(new RegExp(`(?:function|on function)\\s+public\\.${name}\\s*\\(`, "gi"))];
      expect(calls.length, name).toBe(decl.length);
    }
  });

  it("revokes all from public, anon and authenticated, and grants execute to service_role, once per function", () => {
    const revokes = [...code.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => tight(norm(m[0])));
    expect(revokes).toEqual(
      [HELPER, RECOMPUTE, CLEAR].map((n) => `revoke all on function ${SIG[n]} from public, anon, authenticated;`),
    );
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => tight(norm(m[0])));
    expect(grants).toEqual([HELPER, RECOMPUTE, CLEAR].map((n) => `grant execute on function ${SIG[n]} to service_role;`));
    expect(code).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("comments every function (migration number, service_role, what it never writes)", () => {
    for (const name of [HELPER, RECOMPUTE, CLEAR]) {
      const m = new RegExp(`comment\\s+on\\s+function\\s+public\\.${name}\\s*\\([^)]*\\)\\s+is\\s+([\\s\\S]*?);\\s*\\n`, "i").exec(code);
      expect(m, `comment on ${name}`).not.toBeNull();
      const text = (m as RegExpExecArray)[1] as string;
      expect(text, name).toContain("132");
      expect(text, name).toMatch(/service_role/);
    }
    const rec = /comment\s+on\s+function\s+public\.recompute_bias_distribution_range[\s\S]*?;\s*\n/i.exec(code)?.[0] ?? "";
    expect(rec).toMatch(/dry run/i);
    expect(rec).toMatch(/updated_at/);
    const clr = /comment\s+on\s+function\s+public\.clear_false_blindspots_range[\s\S]*?;\s*\n/i.exec(code)?.[0] ?? "";
    expect(clr).toMatch(/never/i);
    expect(clr).toMatch(/is_blindspot/);
  });

  it("takes no table lock and no row lock: only the advisory try-lock and lock_timeout", () => {
    expect(code).not.toMatch(/\block\s+table\b/i);
    expect(code).not.toMatch(/\bfor\s+(update|share|no key update)\b/i);
    expect(code).not.toMatch(/pg_advisory_xact_lock\s*\(/i); // only the try_ variant
  });
});

describe("132 function headers", () => {
  it("legacy_bias_voter_dists(p_from, p_to) returns table(cluster_id, stored, dist, is_blindspot, rule_ok), language sql stable, security definer, empty search_path", () => {
    const h = heads[HELPER] as string;
    expect(h).toMatch(
      /^create or replace function public\.legacy_bias_voter_dists\(p_from timestamptz, p_to timestamptz\) returns table\(cluster_id uuid, stored jsonb, dist jsonb, is_blindspot boolean, rule_ok boolean\) /,
    );
    expect(h).toMatch(/\blanguage sql\b/);
    expect(h).toMatch(/\bstable\b/);
    expect(h).not.toMatch(/\bimmutable\b|\bvolatile\b/);
    expect(h).toMatch(/\bsecurity definer\b/);
    expect(h).toMatch(/\bset search_path = ''/);
    expect(h).not.toMatch(/\block_timeout\b/);
  });

  it.each([
    [RECOMPUTE, "returns table\\(scanned integer, would_change integer, changed integer\\)"],
    [CLEAR, "returns table\\(would_clear integer, would_newly_flag integer, cleared integer\\)"],
  ])("%s(p_from, p_to, p_dry_run default true) is plpgsql, security definer, volatile, search_path '' and lock_timeout 5s", (name, ret) => {
    const h = heads[name as string] as string;
    expect(h).toMatch(
      new RegExp(
        `^create or replace function public\\.${name}\\(p_from timestamptz, p_to timestamptz, p_dry_run boolean default true\\) ${ret} `,
      ),
    );
    expect(h).toMatch(/\blanguage plpgsql\b/);
    expect(h).toMatch(/\bsecurity definer\b/);
    expect(h).toMatch(/\bset search_path = ''/);
    expect(h).toMatch(/\bset lock_timeout = '5s'/);
    // volatile: no stable / immutable keyword (a writer must see what the last lock holder committed)
    expect(h).not.toMatch(/\b(stable|immutable)\b/);
  });
});

describe("132 helper body (legacy_bias_voter_dists)", () => {
  const body = () => bodies[HELPER] as string;
  const blank = () => bodiesBlank[HELPER] as string;

  it("windows on clusters.updated_at, clamped to 31 days from p_from", () => {
    expect(body()).toMatch(
      /from public\.clusters c where c\.updated_at >= p_from and c\.updated_at < least\(p_to, p_from \+ interval '31 days'\)/,
    );
  });

  it("counts voting members the way 034 and 064 do: cluster_articles -> articles -> sources, kind in the voting set", () => {
    expect(body()).toMatch(
      /from public\.cluster_articles ca join public\.articles a on a\.id = ca\.article_id join public\.sources s on s\.id = a\.source_id where s\.kind in \(/,
    );
    expect(inList(body(), /\bs\.kind/)).toEqual([...VOTING_SOURCE_KINDS]);
  });

  it("votes does not join the window CTE: a SQL function plans with parameters (no value sniffing), estimates the window at 0.5% of clusters and would rescan the CTE once per cluster", () => {
    // measured locally at 13,720 clusters: 4,110 ms with `from win w join public.cluster_articles ...`, 93 ms without
    const votes = /votes as \((.*?)\), dists as/.exec(body())?.[1] ?? "";
    expect(votes.length).toBeGreaterThan(0);
    expect(votes).not.toMatch(/\bwin\b|\bw\./);
    // the window CTE is read exactly once, by dists
    expect([...body().matchAll(/\bwin\b/g)]).toHaveLength(2);
  });

  it("left joins the votes so a cluster without voting members gets the all-zero distribution", () => {
    expect(body()).toMatch(/from win w left join votes v on v\.cluster_id = w\.id group by w\.id, w\.stored, w\.is_blindspot/);
  });

  it("builds the ten keys with pg_catalog.count(...) filter, one vote per article", () => {
    for (const key of BIAS_KEYS) {
      expect(body(), key).toContain(`'${key}', pg_catalog.count(v.bias) filter (where v.bias = '${key}')`);
    }
    expect(body()).toMatch(/pg_catalog\.jsonb_build_object\(/);
    // no distinct-source counting
    expect(blank()).not.toMatch(/count\(\s*distinct/i);
  });

  it("restricts the zone tally to the ten known keys", () => {
    expect(inList(body(), /\be\.bias_key/).sort()).toEqual([...BIAS_KEYS].sort());
  });

  it("applies the contract rule: total >= BLINDSPOT.minSources and dominant share >= BLINDSPOT.dominantShare", () => {
    expect(BLINDSPOT.minSources).toBe(5);
    expect(BLINDSPOT.dominantShare).toBe(0.8);
    const minRe = new RegExp(`\\bt\\.total\\s*>=\\s*${BLINDSPOT.minSources}\\b`);
    const shareRe = new RegExp(`nullif\\(t\\.total,\\s*0\\)\\s*>=\\s*${String(BLINDSPOT.dominantShare).replace(".", "\\.")}\\b`);
    expect(body()).toMatch(minRe);
    expect(body()).toMatch(shareRe);
    // rule_ok is never null: zero voters means "does not qualify"
    expect(body()).toMatch(/coalesce\(t\.total >= 5 and [^;]*?>= 0\.8, false\) as rule_ok/);
    // no other thresholds
    expect([...blank().matchAll(/>=\s*(\d+(?:\.\d+)?)/g)].map((m) => m[1]).filter((n) => n !== "5" && n !== "0.8")).toEqual([]);
  });

  it("returns stored = c.bias_distribution and is_blindspot = coalesce(c.is_blindspot, false)", () => {
    expect(body()).toContain("c.bias_distribution as stored");
    expect(body()).toContain("coalesce(c.is_blindspot, false) as is_blindspot");
  });

  it("is read-only and qualifies its catalog calls", () => {
    expect(blank()).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
    const bare = [
      ...blank().matchAll(/(?<![\w.])(count|sum|max|min|jsonb_build_object|jsonb_each_text|array_agg|now|hashtext)\s*\(/gi),
    ].map((m) => m[1]);
    expect(bare).toEqual([]);
    for (const fn of ["count", "sum", "max", "jsonb_build_object", "jsonb_each_text"]) {
      expect(blank(), fn).toContain(`pg_catalog.${fn}(`);
    }
  });

  it("every relation is in public or is one of its own CTEs", () => {
    const rels = [...blank().matchAll(/\b(?:from|join)\s+([a-z_.]+)/gi)].map((m) => m[1] as string);
    expect(rels.length).toBeGreaterThan(0);
    const ctes = new Set(["win", "votes", "dists", "counts", "zone_totals", "verdicts", "lateral"]);
    for (const r of rels) {
      expect(r.startsWith("public.") || r.startsWith("pg_catalog.") || ctes.has(r), `from/join ${r}`).toBe(true);
    }
  });
});

describe("132 writers (recompute_bias_distribution_range, clear_false_blindspots_range)", () => {
  const WRITERS = [RECOMPUTE, CLEAR] as const;
  const body = (n: string) => bodies[n] as string;
  const blank = (n: string) => bodiesBlank[n] as string;

  it.each(WRITERS)("%s: dry run is the default, and a null p_dry_run is a dry run too", (name) => {
    expect(body(name)).toMatch(/v_dry_run boolean := coalesce\(p_dry_run, true\)/);
    expect([...body(name).matchAll(/\bp_dry_run\b/g)]).toHaveLength(1);
  });

  it.each(WRITERS)("%s: raises 22023 when a bound is null or p_to <= p_from", (name) => {
    expect(body(name)).toMatch(
      /if p_from is null or p_to is null or p_to <= p_from then raise exception using errcode = '22023', message = '/,
    );
  });

  it.each(WRITERS)("%s: clamps the window to 31 days with least(p_to, p_from + interval '31 days')", (name) => {
    expect(body(name)).toMatch(/v_to := least\(p_to, p_from \+ interval '31 days'\);/);
    expect([...body(name).matchAll(/\b31 days\b/g)]).toHaveLength(1);
  });

  it.each(WRITERS)("%s: takes the shared advisory try-lock and raises 55P03 when another run holds it", (name) => {
    expect(body(name)).toMatch(
      /if not pg_catalog\.pg_try_advisory_xact_lock\(\s*pg_catalog\.hashtext\('132_legacy_bias_range_tools'\)\s*\) then raise exception using errcode = '55P03'/,
    );
  });

  it.each(WRITERS)("%s: validates, then clamps, then locks, then counts, then (only if not a dry run) writes", (name) => {
    const b = body(name);
    const order = [
      b.search(/p_from is null or p_to is null/),
      b.search(/v_to := least\(/),
      b.search(/pg_try_advisory_xact_lock/),
      b.search(/from public\.legacy_bias_voter_dists\(p_from, v_to\) d;/),
      b.search(/if not v_dry_run then/),
      b.search(/update public\.clusters c/),
      b.search(/end if; return next;/),
    ];
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, c) => a - c)).toEqual(order);
  });

  it.each(WRITERS)("%s: has exactly one update on public.clusters, inside `if not v_dry_run`, and it counts rows with get diagnostics", (name) => {
    const b = body(name);
    expect([...blank(name).matchAll(/\bupdate\b/gi)]).toHaveLength(1);
    expect(blank(name)).not.toMatch(/\b(insert|delete|truncate)\b/i);
    const m = /if not v_dry_run then (update public\.clusters c .*?;) get diagnostics (\w+) = row_count; end if;/.exec(b);
    expect(m, "the update sits inside `if not v_dry_run then ... end if;`").not.toBeNull();
    // nothing writes before the guard
    expect(b.search(/\bupdate\b/)).toBeGreaterThan(b.search(/if not v_dry_run then/));
  });

  it.each(WRITERS)("%s: the update WHERE repeats the window on the target row (so a concurrent stamp is skipped on recheck)", (name) => {
    const upd = /(update public\.clusters c .*?;) get diagnostics/.exec(body(name))?.[1] ?? "";
    expect(upd).toMatch(/from public\.legacy_bias_voter_dists\(p_from, v_to\) d where c\.id = d\.cluster_id and c\.updated_at >= p_from and c\.updated_at < v_to and /);
  });

  it("recompute: sets bias_distribution only, only where it differs, and counts what would change", () => {
    const b = body(RECOMPUTE);
    expect(b).toMatch(
      /update public\.clusters c set bias_distribution = d\.dist from public\.legacy_bias_voter_dists\(p_from, v_to\) d where c\.id = d\.cluster_id and c\.updated_at >= p_from and c\.updated_at < v_to and c\.bias_distribution is distinct from d\.dist;/,
    );
    expect(b).toMatch(/pg_catalog\.count\(\*\)\)?::integer/);
    expect(b).toMatch(/filter \(where d\.stored is distinct from d\.dist\)/);
    expect(b).toMatch(/into scanned, would_change from public\.legacy_bias_voter_dists\(p_from, v_to\) d;/);
    expect(b).toMatch(/changed := 0;/);
    expect(b).toMatch(/get diagnostics changed = row_count;/);
  });

  it("clear: clears is_blindspot and blindspot_side only where the flag is set and the rule fails, and counts both directions", () => {
    const b = body(CLEAR);
    expect(b).toMatch(
      /update public\.clusters c set is_blindspot = false, blindspot_side = null from public\.legacy_bias_voter_dists\(p_from, v_to\) d where c\.id = d\.cluster_id and c\.updated_at >= p_from and c\.updated_at < v_to and c\.is_blindspot and not d\.rule_ok;/,
    );
    expect(b).toMatch(/filter \(where d\.is_blindspot and not d\.rule_ok\)/);
    expect(b).toMatch(/filter \(where not d\.is_blindspot and d\.rule_ok\)/);
    expect(b).toMatch(/into would_clear, would_newly_flag from public\.legacy_bias_voter_dists\(p_from, v_to\) d;/);
    expect(b).toMatch(/cleared := 0;/);
    expect(b).toMatch(/get diagnostics cleared = row_count;/);
  });

  it.each(WRITERS)("%s: returns exactly one row", (name) => {
    expect([...blank(name).matchAll(/\breturn\b[^;]*;/gi)].map((m) => m[0])).toEqual(["return next;"]);
  });

  it.each(WRITERS)("%s: qualifies every catalog call with pg_catalog", (name) => {
    const bare = [
      ...blank(name).matchAll(/(?<![\w.])(count|sum|max|min|hashtext|pg_try_advisory_xact_lock|now|array_agg)\s*\(/gi),
    ].map((m) => m[1]);
    expect(bare).toEqual([]);
    expect(blank(name)).toContain("pg_catalog.pg_try_advisory_xact_lock(");
    expect(blank(name)).toContain("pg_catalog.hashtext(");
    expect(blank(name)).toContain("pg_catalog.count(");
  });

  it("explains the lock and the recheck in comments", () => {
    for (const name of WRITERS) {
      const raw = fnBody(blocks[name] as string);
      expect(raw, name).toMatch(/advisory/i);
      expect(raw, name).toMatch(/recheck|re-check|EvalPlanQual/i);
    }
  });
});

describe("132 whole-file write guards", () => {
  /** Executable SQL: no comments, no string literals. */
  const exec = () => sansStrings(code);

  it("has exactly two data `set` clauses: bias_distribution = d.dist, and is_blindspot = false, blindspot_side = null", () => {
    const sets = [
      ...exec().matchAll(/\bset\s+(?!search_path\b|lock_timeout\b|local\b)([^;]*?)\s+from\b/gi),
    ].map((m) => norm(m[1] as string));
    expect(sets).toEqual(["bias_distribution = d.dist", "is_blindspot = false, blindspot_side = null"]);
  });

  it("every other `set` is a search_path, a lock_timeout or the local lock_timeout of the transaction", () => {
    const setHeads = [...exec().matchAll(/\bset\s+(local\s+)?([a-z_]+)\s*=/gi)].map((m) => `${m[1] ? "local " : ""}${m[2]}`).sort();
    expect(setHeads).toEqual(
      ["bias_distribution", "is_blindspot", "local lock_timeout", "lock_timeout", "lock_timeout", "search_path", "search_path", "search_path"].sort(),
    );
  });

  it("two updates in the whole file, both on public.clusters", () => {
    expect([...exec().matchAll(/\bupdate\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual(["public.clusters", "public.clusters"]);
  });

  it("never writes updated_at: a window stays a window after it is repaired", () => {
    expect(exec()).not.toMatch(/\bupdated_at\s*=(?!=)/);
    expect(exec()).not.toMatch(/\bnow\s*\(/i);
  });

  it("never sets is_blindspot to true and never touches the recall-veto columns", () => {
    expect(exec()).not.toMatch(/is_blindspot\s*=\s*(true|d\.|v\.|not)/i);
    expect(exec()).not.toMatch(/blindspot_recall_veto|blindspot_veto_reason/i);
    expect(exec()).not.toMatch(/\bblindspot_side\s*=(?!\s*null\b)/i);
    expect(exec()).not.toMatch(/recompute_blindspot_flags|cluster_unlink_article|recall_veto/i);
  });

  it("never touches articles, sources or cluster_articles (they are only read)", () => {
    expect(exec()).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\.(articles|sources|cluster_articles)\b/i);
  });
});

describe("132 scripts and runbook call these functions by these names", () => {
  let lib = "";
  let guide = "";
  beforeAll(() => {
    expect(existsSync(LIB_PATH), "scripts/lib/recompute-legacy-bias.mjs must exist").toBe(true);
    lib = readFileSync(LIB_PATH, "utf8");
    guide = readFileSync(GUIDE_PATH, "utf8");
  });

  it("the script calls the two writers with the parameter names of the SQL signature", () => {
    expect(lib).toContain(RECOMPUTE);
    expect(lib).toContain(CLEAR);
    for (const p of ["p_from", "p_to", "p_dry_run"]) expect(lib, p).toContain(p);
    for (const name of [RECOMPUTE, CLEAR]) {
      const params = /\(([^)]*)\)/.exec((heads[name] as string).slice((heads[name] as string).indexOf(name)))?.[1] ?? "";
      expect(params).toMatch(/\bp_from\b.*\bp_to\b.*\bp_dry_run\b/);
    }
  });

  it("the runbook has a 132 section with the operator steps", () => {
    const at = guide.search(/^## 132 /m);
    expect(at, "## 132 section").toBeGreaterThanOrEqual(0);
    const section = guide.slice(at);
    expect(section).toMatch(/APPLY 132 only/);
    expect(section).toContain("node scripts/recompute-legacy-bias.mjs --from");
    expect(section).toContain("--apply");
    expect(section).toContain("--to 2026-09-05");
    expect(section).toMatch(/\\copy/);
    expect(section).toContain("legacy_bias_voter_dists");
    expect(section).toContain("would_newly_flag");
    expect(section).toMatch(/hafta/);
    expect(section).toMatch(/Rollback|rollback/);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the three functions against fixtures, on a throwaway
// Postgres (stub schema plus 132 applied). TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every fixture sits inside
// a transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("132 legacy bias range tools against fixtures (live Postgres)", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  const columnExists = (table: string, column: string): boolean =>
    runPsql(
      `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name = '${column}');`,
    ).trim() === "t";

  /** Deterministic uuid: namespace 1-9, index n. */
  const uid = (ns: number, n: number) => `00000000-0000-4000-8132-${String(ns).padStart(2, "0")}${String(n).padStart(10, "0")}`;
  const srcId = (ns: number, n: number) => uid(ns, 100 + n);
  const artId = (ns: number, n: number) => uid(ns, 200 + n);
  const cluId = (ns: number, n: number) => uid(ns, n);

  let fullSchema = false;
  let withHash = false;
  beforeAll(() => {
    fullSchema = columnExists("clusters", "summary_tr");
    withHash = columnExists("articles", "content_hash");
  });

  const KEYS_SORTED = [...BIAS_KEYS].sort();

  /** A ten-key distribution literal in BIAS_KEYS order. */
  const dist10 = (counts: Record<string, number>) =>
    JSON.stringify(Object.fromEntries(BIAS_KEYS.map((k) => [k, counts[k] ?? 0])));

  interface Src {
    n: number;
    bias: string;
    kind: string;
  }

  function sourcesSql(ns: number, srcs: readonly Src[]): string {
    const vals = srcs.map(
      (s) =>
        `('${srcId(ns, s.n)}', 'fx132 ${ns}-${s.n}', 'fx132-${ns}-${s.n}', 'https://fx132-${ns}-${s.n}.invalid', 'https://fx132-${ns}-${s.n}.invalid/rss', '${s.bias}', '${s.kind}', true)`,
    );
    return `insert into public.sources (id, name, slug, url, rss_url, bias, kind, active) values\n  ${vals.join(",\n  ")};`;
  }

  /** One article per source, same index. */
  function articlesSql(ns: number, count: number): string {
    const vals = Array.from({ length: count }, (_, i) => {
      const url = `'https://fx132.invalid/${ns}/${i}'`;
      return `('${artId(ns, i)}', '${srcId(ns, i)}', 'fx132 ${ns} ${i}', ${url}, '2026-06-01T08:00:00Z'${withHash ? `, md5(${url})` : ""})`;
    });
    return `insert into public.articles (id, source_id, title, url, published_at${withHash ? ", content_hash" : ""}) values\n  ${vals.join(",\n  ")};`;
  }

  function clusterSql(
    ns: number,
    n: number,
    o: { updatedAt: string; dist: string; flagged: boolean; side?: string; count: number },
  ): string {
    const cols = fullSchema
      ? "id, title_tr, title_en, summary_tr, summary_en, first_published, updated_at, bias_distribution, article_count, is_blindspot, blindspot_side"
      : "id, title_tr, first_published, updated_at, bias_distribution, article_count, is_blindspot, blindspot_side";
    const tail = `'2026-05-30T00:00:00Z', '${o.updatedAt}', '${o.dist}'::jsonb, ${o.count}, ${o.flagged}, ${o.side ? `'${o.side}'` : "null"}`;
    const vals = fullSchema
      ? `'${cluId(ns, n)}', 'fx132', 'fx132', 'fx132', 'fx132', ${tail}`
      : `'${cluId(ns, n)}', 'fx132', ${tail}`;
    return `insert into public.clusters (${cols}) values (${vals});`;
  }

  const linkSql = (ns: number, cluster: number, articles: readonly number[]) =>
    `insert into public.cluster_articles (cluster_id, article_id) values ${articles
      .map((a) => `('${cluId(ns, cluster)}', '${artId(ns, a)}')`)
      .join(", ")};`;

  /**
   * Sources: S0..S4 outlet pro_government, S5 and S7 outlet opposition, S6 aggregator pro_government.
   * One article per source (A0..A7). Clusters (each a distinct updated_at, June 2026 unless noted):
   *   L1  A0-A3 + A6 (aggregator)   stored {pro_government:5}   flagged pro_government   <- false flag
   *   L2  A0-A3 + A5 (opposition)   stored correct (4 + 1)      flagged pro_government   <- stays (4/5 = 0.8)
   *   L3  A0-A4 (five outlets)      stored correct (5)          NOT flagged              <- would newly flag, must stay f
   *   L4  like L1, updated_at 2026-10-01 (outside the June window, untouched)
   *   L5  no members                stored {pro_government:5}   flagged pro_government   <- zero total
   *   L6  A0-A4 + A5 + A7           stored correct (5 + 2)      not flagged              <- only scanned (5 of 7 is 0.714, below 0.8)
   */
  function fixtures(ns: number): string {
    return `
${sourcesSql(ns, [
  { n: 0, bias: "pro_government", kind: "outlet" },
  { n: 1, bias: "pro_government", kind: "outlet" },
  { n: 2, bias: "pro_government", kind: "outlet" },
  { n: 3, bias: "pro_government", kind: "outlet" },
  { n: 4, bias: "pro_government", kind: "outlet" },
  { n: 5, bias: "opposition", kind: "outlet" },
  { n: 6, bias: "pro_government", kind: "aggregator" },
  { n: 7, bias: "opposition", kind: "outlet" },
])}
${articlesSql(ns, 8)}
${clusterSql(ns, 1, { updatedAt: "2026-06-10T10:00:00Z", dist: '{"pro_government":5}', flagged: true, side: "pro_government", count: 5 })}
${clusterSql(ns, 2, { updatedAt: "2026-06-11T10:00:00Z", dist: dist10({ pro_government: 4, opposition: 1 }), flagged: true, side: "pro_government", count: 5 })}
${clusterSql(ns, 3, { updatedAt: "2026-06-12T10:00:00Z", dist: dist10({ pro_government: 5 }), flagged: false, count: 5 })}
${clusterSql(ns, 4, { updatedAt: "2026-10-01T10:00:00Z", dist: '{"pro_government":5}', flagged: true, side: "pro_government", count: 5 })}
${clusterSql(ns, 5, { updatedAt: "2026-06-13T10:00:00Z", dist: '{"pro_government":5}', flagged: true, side: "pro_government", count: 5 })}
${clusterSql(ns, 6, { updatedAt: "2026-06-14T10:00:00Z", dist: dist10({ pro_government: 5, opposition: 2 }), flagged: false, count: 7 })}
${linkSql(ns, 1, [0, 1, 2, 3, 6])}
${linkSql(ns, 2, [0, 1, 2, 3, 5])}
${linkSql(ns, 3, [0, 1, 2, 3, 4])}
${linkSql(ns, 4, [0, 1, 2, 3, 6])}
${linkSql(ns, 6, [0, 1, 2, 3, 4, 5, 7])}
`;
  }

  /** One tagged row with the repairable fields of a cluster. */
  const probe = (tag: string, cluster: string) =>
    `select '${tag}', is_blindspot, coalesce(blindspot_side, 'null'), (select string_agg(k || '=' || coalesce(bias_distribution ->> k, 'missing'), ',' order by k) from unnest(array[${KEYS_SORTED.map((k) => `'${k}'`).join(", ")}]) as k), (select count(*) from jsonb_object_keys(bias_distribution)), to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') from public.clusters where id = '${cluster}';`;

  const distOf = (counts: Record<string, number>) => KEYS_SORTED.map((k) => `${k}=${counts[k] ?? 0}`).join(",");

  const fingerprints = (tag: string, ns: number) => `
select '${tag}_all', md5(string_agg(row(c.*)::text, ',' order by c.id)) from public.clusters c;
select '${tag}_ua', md5(string_agg(c.id::text || '@' || c.updated_at::text, ',' order by c.id)) from public.clusters c;
select '${tag}_l4', md5(row(c.*)::text) from public.clusters c where c.id = '${cluId(ns, 4)}';`;

  function rows(out: string): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const line of out.split("\n").filter((l) => l.includes("|"))) {
      const [tag, ...rest] = line.split("|");
      m.set(tag as string, rest);
    }
    return m;
  }

  const WIN = "'2026-06-01', '2026-07-01'";

  it("the target database runs 132: the ledger row and the three functions are there", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '132';").trim()).toBe("1");
    expect(
      runPsql(
        `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('${HELPER}', '${RECOMPUTE}', '${CLEAR}');`,
      ).trim(),
    ).toBe("3");
  });

  describe("(a) a dry run, with the default or with a null p_dry_run, writes nothing; an apply repairs L1 and L5 only", () => {
    const ns = 1;
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      out = rows(
        runPsql(`
begin;
${fixtures(ns)}
${fingerprints("b", ns)}
select 'rec_dry', r.* from public.recompute_bias_distribution_range(${WIN}) r;
select 'clr_dry', r.* from public.clear_false_blindspots_range(${WIN}) r;
select 'rec_null', r.* from public.recompute_bias_distribution_range(${WIN}, null) r;
select 'clr_null', r.* from public.clear_false_blindspots_range(${WIN}, null) r;
select 'rec_named', r.* from public.recompute_bias_distribution_range(p_from => '2026-06-01', p_to => '2026-07-01', p_dry_run => true) r;
${fingerprints("d", ns)}
select 'rec_apply', r.* from public.recompute_bias_distribution_range(${WIN}, false) r;
select 'clr_apply', r.* from public.clear_false_blindspots_range(${WIN}, false) r;
${probe("l1", cluId(ns, 1))}
${probe("l2", cluId(ns, 2))}
${probe("l3", cluId(ns, 3))}
${probe("l5", cluId(ns, 5))}
${probe("l6", cluId(ns, 6))}
${fingerprints("a", ns)}
select 'rec_again', r.* from public.recompute_bias_distribution_range(${WIN}, false) r;
select 'clr_again', r.* from public.clear_false_blindspots_range(${WIN}, false) r;
${fingerprints("z", ns)}
rollback;
`),
      );
    });

    it("2-arg calls are dry runs: recompute (5, 2, 0), clear (2, 1, 0) [L1 and L5 clear, L3 would newly flag]", () => {
      expect(out.get("rec_dry")).toEqual(["5", "2", "0"]);
      expect(out.get("clr_dry")).toEqual(["2", "1", "0"]);
      expect(out.get("rec_named")).toEqual(["5", "2", "0"]);
    });

    it("p_dry_run => null is a dry run: the same counts, nothing written", () => {
      expect(out.get("rec_null")).toEqual(["5", "2", "0"]);
      expect(out.get("clr_null")).toEqual(["2", "1", "0"]);
    });

    it("the clusters table is byte-identical after the dry runs (md5 of every row)", () => {
      expect(out.get("d_all")).toEqual(out.get("b_all"));
      expect((out.get("b_all") as string[])[0]).toMatch(/^[0-9a-f]{32}$/);
    });

    it("apply returns changed = would_change and cleared = would_clear", () => {
      expect(out.get("rec_apply")).toEqual(["5", "2", "2"]);
      expect(out.get("clr_apply")).toEqual(["2", "1", "2"]);
    });

    it("L1 gets the ten-key voter distribution (pro_government 4, the rest 0) and loses its false flag and side", () => {
      const l1 = out.get("l1") as string[];
      expect(l1[0]).toBe("f");
      expect(l1[1]).toBe("null");
      expect(l1[2]).toBe(distOf({ pro_government: 4 }));
      expect(l1[3]).toBe("10");
    });

    it("L5 (no members) goes to the all-zero distribution and loses its flag", () => {
      const l5 = out.get("l5") as string[];
      expect(l5[0]).toBe("f");
      expect(l5[1]).toBe("null");
      expect(l5[2]).toBe(distOf({}));
      expect(l5[3]).toBe("10");
    });

    it("L2 stays flagged with its side and distribution (4 of 5 voters is exactly 0.8)", () => {
      const l2 = out.get("l2") as string[];
      expect(l2[0]).toBe("t");
      expect(l2[1]).toBe("pro_government");
      expect(l2[2]).toBe(distOf({ pro_government: 4, opposition: 1 }));
    });

    it("L3 would newly flag but is never flagged by the tool", () => {
      const l3 = out.get("l3") as string[];
      expect(l3[0]).toBe("f");
      expect(l3[1]).toBe("null");
      expect(l3[2]).toBe(distOf({ pro_government: 5 }));
    });

    it("L6 (correct, unflagged, 5 of 7 voters in one zone) is only scanned: below 0.8 it is not a candidate", () => {
      const l6 = out.get("l6") as string[];
      expect(l6[0]).toBe("f");
      expect(l6[2]).toBe(distOf({ pro_government: 5, opposition: 2 }));
    });

    it("L4 (updated_at outside the window) is byte-identical", () => {
      expect(out.get("a_l4")).toEqual(out.get("b_l4"));
    });

    it("no cluster's updated_at changed, in any step", () => {
      expect(out.get("a_ua")).toEqual(out.get("b_ua"));
      expect(out.get("z_ua")).toEqual(out.get("b_ua"));
      expect(out.get("d_ua")).toEqual(out.get("b_ua"));
    });

    it("a second apply changes and clears nothing, and still counts the one cluster it would newly flag", () => {
      expect(out.get("rec_again")).toEqual(["5", "0", "0"]);
      expect(out.get("clr_again")).toEqual(["0", "1", "0"]);
      expect(out.get("z_all")).toEqual(out.get("a_all"));
    });
  });

  describe("(b) the window is clamped to 31 days from p_from", () => {
    const ns = 2;
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      out = rows(
        runPsql(`
begin;
${fixtures(ns)}
${fingerprints("b", ns)}
select 'wide_dry', r.* from public.recompute_bias_distribution_range('2026-06-01', '2026-12-31') r;
select 'may_dry', r.* from public.recompute_bias_distribution_range('2026-05-01', '2026-12-31') r;
select 'wide_clr', r.* from public.clear_false_blindspots_range('2026-06-01', '2026-12-31') r;
select 'wide_apply', r.* from public.recompute_bias_distribution_range('2026-06-01', '2026-12-31', false) r;
select 'wide_clr_apply', r.* from public.clear_false_blindspots_range('2026-06-01', '2026-12-31', false) r;
${fingerprints("a", ns)}
${probe("l1", cluId(ns, 1))}
rollback;
`),
      );
    });

    it("scans only the 31 days after p_from: L4 (2026-10-01) is not scanned", () => {
      expect(out.get("wide_dry")).toEqual(["5", "2", "0"]);
      expect(out.get("wide_clr")).toEqual(["2", "1", "0"]);
    });

    it("a window that starts a month early clamps to before the first June cluster: scanned 0", () => {
      expect(out.get("may_dry")).toEqual(["0", "0", "0"]);
    });

    it("applying the wide window repairs June and leaves L4 byte-identical", () => {
      expect(out.get("wide_apply")).toEqual(["5", "2", "2"]);
      expect(out.get("wide_clr_apply")).toEqual(["2", "1", "2"]);
      expect(out.get("a_l4")).toEqual(out.get("b_l4"));
      expect(out.get("a_ua")).toEqual(out.get("b_ua"));
      expect((out.get("l1") as string[])[0]).toBe("f");
    });
  });

  describe("(c) bad windows raise 22023, and nothing is written", () => {
    const ns = 3;
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      const attempt = (call: string) => `begin ${call}; exception when others then r := r || sqlstate || ','; end;`;
      out = rows(
        runPsql(`
begin;
${fixtures(ns)}
${fingerprints("b", ns)}
do $c$
declare r text := '';
begin
  ${attempt("perform * from public.recompute_bias_distribution_range('2026-07-01', '2026-06-01', false)")}
  ${attempt("perform * from public.recompute_bias_distribution_range('2026-06-01', '2026-06-01', false)")}
  ${attempt("perform * from public.recompute_bias_distribution_range(null, '2026-06-01', false)")}
  ${attempt("perform * from public.recompute_bias_distribution_range('2026-06-01', null, false)")}
  ${attempt("perform * from public.clear_false_blindspots_range('2026-07-01', '2026-06-01', false)")}
  ${attempt("perform * from public.clear_false_blindspots_range('2026-06-01', '2026-06-01', false)")}
  ${attempt("perform * from public.clear_false_blindspots_range(null, '2026-06-01', false)")}
  ${attempt("perform * from public.clear_false_blindspots_range('2026-06-01', null, false)")}
  perform set_config('tayf.errs', r, true);
end
$c$;
select 'errs', current_setting('tayf.errs', true);
${fingerprints("a", ns)}
rollback;
`),
      );
    });

    it("an inverted, empty or null window raises 22023 in both writers, even with p_dry_run => false", () => {
      expect(out.get("errs")).toEqual(["22023,22023,22023,22023,22023,22023,22023,22023,"]);
    });

    it("the failed calls wrote nothing", () => {
      expect(out.get("a_all")).toEqual(out.get("b_all"));
    });
  });

  it("rolled the fixtures back", () => {
    expect(runPsql("select count(*) from public.sources where slug like 'fx132-%';").trim()).toBe("0");
    expect(runPsql("select count(*) from public.articles where url like 'https://fx132.invalid/%';").trim()).toBe("0");
    expect(runPsql("select count(*) from public.clusters where title_tr like 'fx132%';").trim()).toBe("0");
  });

  it("service_role only may execute any of the three; all are security definer with an empty search_path", () => {
    for (const name of [HELPER, RECOMPUTE, CLEAR]) {
      const sig = SIG[name].replace(/, /g, ",");
      expect(
        runPsql(
          `select has_function_privilege('anon', '${sig}', 'execute'), has_function_privilege('authenticated', '${sig}', 'execute'), has_function_privilege('service_role', '${sig}', 'execute');`,
        ).trim(),
        name,
      ).toBe("f|f|t");
      expect(
        runPsql(`select prosecdef, proconfig @> array['search_path=""']::text[] from pg_proc where oid = '${sig}'::regprocedure;`).trim(),
        name,
      ).toBe("t|t");
    }
    // the writers are volatile and carry lock_timeout; the helper is stable
    expect(
      runPsql(
        `select p.proname, p.provolatile, coalesce(p.proconfig @> array['lock_timeout=5s']::text[], false) from pg_proc p where p.oid in ('${SIG[HELPER].replace(/, /g, ",")}'::regprocedure, '${SIG[RECOMPUTE].replace(/, /g, ",")}'::regprocedure, '${SIG[CLEAR].replace(/, /g, ",")}'::regprocedure) order by p.proname;`,
      ).trim(),
    ).toBe([`${CLEAR}|v|t`, `${HELPER}|s|f`, `${RECOMPUTE}|v|t`].join("\n"));
  });
});
