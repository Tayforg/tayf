import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Static SQL-contract test for migration 189 ("Başka kaynaklarla aynı başlık ve
// özet" counts every cluster, h103-sourcescores-1). 189 re-creates ONLY
// public.source_reliability_refresh_source() of 111: the wire gate is gone, so
// n_wire_copy becomes the number of the source's in-window clusters whose
// deduped member carries the same content_hash as the deduped member of
// ANOTHER, non-aggregator source. Everything else of 111's function (cadence,
// zmap, mine, mem, zc, mix, the upsert, the signature, SECURITY DEFINER, the
// empty search_path and the grants) must stay as it was, which this file pins by
// comparing the texts with 111's after whitespace normalisation. Comments are
// stripped before every code assertion so prose can never satisfy a guard
// (same style as 111's test).

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION = resolve(
  ROOT,
  "supabase",
  "migrations",
  "189_source_reliability_copy_any_cluster.sql",
);
const MIGRATION_111 = resolve(ROOT, "supabase", "migrations", "111_source_reliability.sql");

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

interface FnBlock {
  args: string;
  returns: string;
  body: string;
}

// Same header-shape parser as 111's test: a function that deviates from
// `returns <t> language plpgsql security definer set search_path = '' as $fn$`
// is simply not found, which fails the tests below.
function parseFunctions(code: string): Record<string, FnBlock> {
  const out: Record<string, FnBlock> = {};
  const re =
    /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\s+(\w+)\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''\s+as\s+\$fn\$([\s\S]*?)\$fn\$/gi;
  for (const m of code.matchAll(re)) {
    out[m[1]!] = { args: m[2]!, returns: m[3]!, body: m[4]! };
  }
  return out;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The text from `start` up to the first of `ends` that follows it ("" when absent). */
function slice(body: string, start: string, ends: string[]): string {
  const i = body.indexOf(start);
  if (i < 0) return "";
  let j = -1;
  for (const e of ends) {
    const k = body.indexOf(e, i + start.length);
    if (k >= 0 && (j < 0 || k < j)) j = k;
  }
  return j < 0 ? "" : body.slice(i, j);
}

const PARTS: ReadonlyArray<readonly [string, string, string[]]> = [
  ["the pre-`with` part (declare, cadence select)", "declare", ["with zmap("]],
  ["zmap", "zmap(bias_key, zone) as (values", [", mine as ("]],
  ["mine", "mine as (", [", mem as ("]],
  ["mem", "mem as (", [", wire as (", ", copies as ("]],
  ["zc", "zc as (", [", mix as ("]],
  ["mix", "mix as (", [" insert into public.source_reliability_30d"]],
  ["the insert / on-conflict block", "insert into public.source_reliability_30d (", ["return true;"]],
];

const COPIES_189 =
  "copies as (select o.cluster_id from mem o where o.source_id = p_source_id and o.content_hash is not null and exists (select 1 from mem y join public.sources s on s.id = y.source_id where y.cluster_id = o.cluster_id and y.source_id <> p_source_id and y.content_hash = o.content_hash and s.kind <> 'aggregator'))";

describe("migration 189_source_reliability_copy_any_cluster.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fns: Record<string, FnBlock> = {};
  let fns111: Record<string, FnBlock> = {};
  let body = "";
  let body111 = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION), "189_source_reliability_copy_any_cluster.sql must exist").toBe(
      true,
    );
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    fns = parseFunctions(code);
    fns111 = parseFunctions(stripComments(readFileSync(MIGRATION_111, "utf8")));
    body = collapse(fns.source_reliability_refresh_source?.body ?? "");
    body111 = collapse(fns111.source_reliability_refresh_source?.body ?? "");
  });

  it("sanity: comment stripping is non-vacuous and 111's function parses", () => {
    expect(raw).toMatch(/cron job|\*\/15/i);
    expect(raw.length).toBeGreaterThan(code.length);
    expect(body111.length, "111's function must parse").toBeGreaterThan(500);
  });

  // ---- header ---------------------------------------------------------------

  it("the header states the new definition, the evidence, the refresh timing and the rollback", () => {
    expect(raw).toMatch(/DEFINITION/);
    expect(raw).toMatch(/n_wire_copy/);
    expect(raw).toMatch(/aggregator/);
    expect(raw).toMatch(/any cluster size|every cluster/i);
    expect(raw).toMatch(/dedupeBySource/);
    expect(raw).toMatch(/strictFingerprint/);
    expect(raw).toMatch(/article body is not compared/i);
    expect(raw).toMatch(/Europe\/Istanbul|Türkiye/i);
    expect(raw).not.toMatch(/byte-identical/i);
    expect(raw).not.toMatch(/outlet's text/i);
    // The old gate is described as removed, not silently dropped.
    expect(raw).toMatch(/wire gate/i);
    // Refresh timing: no data rewrite, the batch recomputes within its cycle.
    expect(raw).toMatch(/20 hours/);
    expect(raw).toMatch(/no (data rewrite|backfill)/i);
    // Rollback = re-apply 111's function body.
    expect(raw).toMatch(/ROLLBACK/);
    expect(raw).toMatch(/re-apply[^\n]*111/i);
    expect(raw).toMatch(/delete from supabase_migrations\.schema_migrations where version = '189'/);
  });

  // database-L1: `create or replace function` keeps the function's oid and with
  // it its pg_description row, so re-running only 111's function statement would
  // leave 189's "of any size" comment on the restored, gated body. The rollback
  // must say to restore 111's `comment on function` too (172, 185 and 186 do).
  it("the header ROLLBACK block says to restore 111's `comment on function` as well as the function body", () => {
    const start = raw.indexOf("-- ROLLBACK");
    const end = raw.indexOf("\nbegin;", start);
    expect(start, "-- ROLLBACK marker").toBeGreaterThan(-1);
    expect(end, "begin; after the header").toBeGreaterThan(start);
    const rollback = raw.slice(start, end);
    expect(rollback).toMatch(/re-apply[^\n]*111/i);
    expect(rollback).toMatch(/comment on function/i);
  });

  it("docs/migration-guide.md: the 189 section's Rollback line says to re-run 111's `comment on function` too", () => {
    const guide = readFileSync(resolve(ROOT, "docs", "migration-guide.md"), "utf8");
    const from = guide.indexOf("## 189 —");
    expect(from, "the 189 section").toBeGreaterThan(-1);
    const next = guide.indexOf("\n## ", from + 1);
    const section = next < 0 ? guide.slice(from) : guide.slice(from, next);
    const line = section.split("\n").find((l) => l.startsWith("**Rollback:**"));
    expect(line, "**Rollback:** line of the 189 section").toBeDefined();
    expect(line).toMatch(/comment on function/);
    expect(line).toMatch(/111_source_reliability\.sql/);
  });

  // ---- function: shape + security ------------------------------------------

  it("creates exactly one function: source_reliability_refresh_source, SECURITY DEFINER, search_path ''", () => {
    expect(Object.keys(fns)).toEqual(["source_reliability_refresh_source"]);
    expect([...code.matchAll(/create\s+or\s+replace\s+function\b/gi)]).toHaveLength(1);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(1);
    expect([...code.matchAll(/search_path\s*=\s*''/gi)]).toHaveLength(1);
  });

  it("keeps 111's (uuid, integer default 30) -> boolean signature, argument for argument", () => {
    const f = fns.source_reliability_refresh_source!;
    expect(collapse(f.args)).toBe("p_source_id uuid, p_days integer default 30");
    expect(collapse(f.args)).toBe(collapse(fns111.source_reliability_refresh_source!.args));
    expect(f.returns).toBe("boolean");
    expect(f.returns).toBe(fns111.source_reliability_refresh_source!.returns);
  });

  it("does not redefine the batch, the table, the karne functions or anything else", () => {
    expect(code).not.toMatch(/source_karne_refresh_batch\s*\(/i);
    expect(code).not.toMatch(/function\s+public\.source_karne_refresh(_source)?\s*\(/i);
    expect(code).not.toMatch(/\bcreate\s+(table|index|unique|view|trigger|policy|extension)\b/i);
    expect(code).not.toMatch(/\balter\b/i);
    expect(code).not.toMatch(/\bdrop\s+\w+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bcron\./i);
  });

  it("writes no data and refreshes nothing at the top level (no backfill, no manual call)", () => {
    const topLevel = code.replace(/\$fn\$[\s\S]*?\$fn\$/g, "");
    expect(topLevel).not.toMatch(/\bselect\s+public\.source_/i);
    expect(topLevel).not.toMatch(/\bperform\s+public\.source_/i);
    expect(topLevel).not.toMatch(/\bupdate\s+public\./i);
    expect(topLevel).not.toMatch(/\bdelete\s+from\s+public\./i);
    const inserts = [...topLevel.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("takes no lock", () => {
    expect(code).not.toMatch(/\block\b/i);
    expect(body).not.toMatch(/advisory/i);
  });

  // ---- grants ----------------------------------------------------------------

  it("revokes from public/anon/authenticated and grants service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.source_reliability_refresh_source\s*\(\s*uuid\s*,\s*integer\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.source_reliability_refresh_source\s*\(\s*uuid\s*,\s*integer\s*\)\s+to\s+service_role\s*;/i,
    );
    expect([...code.matchAll(/\bgrant\b/gi)]).toHaveLength(1);
  });

  it("never grants anything to anon/authenticated", () => {
    expect(code).not.toMatch(/grant\s+[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i);
  });

  it("comments the function with the new definition", () => {
    const m = code.match(
      /comment\s+on\s+function\s+public\.source_reliability_refresh_source\s*\(\s*uuid\s*,\s*integer\s*\)\s+is\s+([\s\S]*?);/i,
    );
    expect(m, "comment on function").not.toBeNull();
    const c = collapse(m![1]!.replace(/'\s*'/g, ""));
    expect(c).toMatch(/aggregator/i);
    expect(c).toMatch(/service_role only/i);
    expect(c).not.toMatch(/detectWireRedistribution parity/i);
  });

  // ---- body: the wire gate is gone -------------------------------------------

  describe("the body", () => {
    it("clamps the window to 1..90, stamps v_end with now() and returns false for a missing or inactive source", () => {
      expect(body).toMatch(/least\(greatest\(coalesce\(p_days, 30\), 1\), 90\)/);
      expect(body).toMatch(/v_end timestamptz := pg_catalog\.now\(\)/);
      expect(body).toMatch(
        /perform 1 from public\.sources where id = p_source_id and active; if not found then return false; end if;/,
      );
      expect(body).toMatch(/return true;\s*end$/);
    });

    it("has no `wire` CTE, no join on it, no `count(*) >= 3` and no `<= 0.5` ratio", () => {
      expect(body).not.toMatch(/\bwire\s+as\s*\(/i);
      expect(body).not.toMatch(/\bjoin\s+wire\b/i);
      expect(body).not.toMatch(/count\(\*\)\s*>=\s*3/i);
      expect(body).not.toMatch(/<=\s*0\.5/);
      expect(body).not.toMatch(/count\(distinct coalesce\(/i);
      expect(body).not.toMatch(/\bhaving\b/i);
    });

    it("`copies` reads the source's own deduped row with a non-null hash", () => {
      const copies = slice(body, "copies as (", [", zc as ("]);
      expect(copies).not.toBe("");
      expect(copies).toContain("from mem o");
      expect(copies).toContain("o.source_id = p_source_id");
      expect(copies).toContain("o.content_hash is not null");
    });

    it("`copies` requires ANOTHER source with the same hash, joined to public.sources, kind <> 'aggregator' on the partner", () => {
      const copies = slice(body, "copies as (", [", zc as ("]);
      expect(copies).toContain("y.source_id <> p_source_id");
      expect(copies).toContain("y.content_hash = o.content_hash");
      expect(copies).toContain("y.cluster_id = o.cluster_id");
      expect(copies).toContain("join public.sources s on s.id = y.source_id");
      expect(copies).toContain("s.kind <> 'aggregator'");
      // The aggregator exclusion is on the partner (s is joined on y.source_id), never on
      // the source's own row (o): an aggregator's own share still counts its non-aggregator partners.
      expect(copies).not.toMatch(/\bo\.kind\b/);
      expect([...copies.matchAll(/\bkind\b/g)]).toHaveLength(1);
    });

    it("`copies` is exactly the pinned text", () => {
      expect(slice(body, "copies as (", [", zc as ("])).toBe(COPIES_189);
    });

    it("`copies` is a subset of `mine` (one row per cluster of the source), so n_wire_copy <= n_clusters holds", () => {
      // `mem o` is the deduped member of the source inside a `mine` cluster, one row per cluster.
      expect(body).toMatch(
        /mem as \(select distinct on \(ca\.cluster_id, a\.source_id\) ca\.cluster_id, a\.source_id, a\.id, a\.content_hash from mine m join public\.cluster_articles ca on ca\.cluster_id = m\.cluster_id/,
      );
      expect(body).toMatch(/\(select pg_catalog\.count\(\*\) from copies\)::int/);
      expect(body).toMatch(/\(select pg_catalog\.count\(\*\) from mine\)::int/);
    });

    it.each(PARTS)("%s equals 111's after whitespace normalisation", (_label, start, ends) => {
      const mine189 = slice(body, start, ends);
      const mine111 = slice(body111, start, ends);
      expect(mine111, "111's part must be found").not.toBe("");
      expect(mine189, "189's part must be found").not.toBe("");
      expect(mine189).toBe(mine111);
    });

    it("keeps the CTE order zmap, mine, mem, copies, zc, mix before the insert", () => {
      const order = [
        "zmap(bias_key, zone) as (values",
        ", mine as (",
        ", mem as (",
        ", copies as (",
        ", zc as (",
        ", mix as (",
        " insert into public.source_reliability_30d",
      ].map((n) => body.indexOf(n));
      expect(order.every((i) => i > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("upserts every column keyed on source_id, as 111 does", () => {
      expect(body).toMatch(
        /insert into public\.source_reliability_30d \( source_id, window_days, window_start, window_end, n_articles, active_days, n_clusters, n_wire_copy, zone_mix, computed_at\)/,
      );
      expect(body).toMatch(/on conflict \(source_id\) do update set/);
      for (const col of [
        "window_days",
        "window_start",
        "window_end",
        "n_articles",
        "active_days",
        "n_clusters",
        "n_wire_copy",
        "zone_mix",
        "computed_at",
      ]) {
        expect(body).toContain(`${col} = excluded.${col}`);
      }
    });
  });

  // ---- hygiene ----------------------------------------------------------------

  it("writes the ledger row", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'189'\s*,\s*'189_source_reliability_copy_any_cluster'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("leaves 111 byte for byte alone: it still carries its wire gate", () => {
    const raw111 = readFileSync(MIGRATION_111, "utf8");
    expect(raw111).toMatch(/having pg_catalog\.count\(\*\) >= 3/);
    expect(raw111).toMatch(/\/ pg_catalog\.count\(\*\) <= 0\.5\)/);
  });
});
