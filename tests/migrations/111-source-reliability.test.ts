import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { BALANCE_MIN_SOURCES } from "../../src/lib/bias/balance";
import { BIAS_TO_ZONE } from "../../src/lib/bias/config";
import { WIRE_UNIQUE_HASH_RATIO } from "../../src/lib/clusters/wire";

// Static SQL-contract test for migration 111 ("Kaynak göstergeleri"): a
// sibling rollup table (cadence, wire-copy count, zone mix), a per-source
// refresh function and a re-created bounded batch that refreshes both the
// Kapsama karnesi row (096/106) and the reliability row. Comments are
// stripped before every assertion so prose can never satisfy a code guard
// (same style as 106's test).

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION = resolve(ROOT, "supabase", "migrations", "111_source_reliability.sql");
const MIGRATION_106 = resolve(ROOT, "supabase", "migrations", "106_source_karne_resilient.sql");
const WIRE_TS = resolve(ROOT, "src", "lib", "clusters", "wire.ts");

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

interface FnBlock {
  args: string;
  returns: string;
  body: string;
}

// Parses every `create or replace function public.<name>(...) returns <t>
// language plpgsql security definer set search_path = '' as $fn$ ... $fn$`.
// A function that deviates from that exact header shape is simply not found,
// which fails the tests below (so "security definer + empty search_path" is
// asserted structurally, per function).
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

describe("migration 111_source_reliability.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fns: Record<string, FnBlock> = {};
  let fns106: Record<string, FnBlock> = {};

  beforeAll(() => {
    expect(existsSync(MIGRATION), "111_source_reliability.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    fns = parseFunctions(code);
    fns106 = parseFunctions(stripComments(readFileSync(MIGRATION_106, "utf8")));
  });

  it("sanity: comment stripping is non-vacuous (header mentions cron.schedule, code does not)", () => {
    expect(raw).toMatch(/cron\.schedule|cron job/i);
    expect(raw.length).toBeGreaterThan(code.length);
  });

  it("the header pins the definitions, the design, the dry run, deploy notes and rollback", () => {
    expect(raw).toMatch(/DEFINITIONS/);
    expect(raw).toMatch(/DESIGN/);
    expect(raw).toMatch(/DRY RUN/);
    expect(raw).toMatch(/DEPLOY/i);
    expect(raw).toMatch(/ROLLBACK/i);
    expect(raw).toMatch(/Europe\/Istanbul/);
    expect(raw).toMatch(/detectWireRedistribution/);
    expect(raw).toMatch(/dedupeBySource/);
  });

  it("the header describes wire copy as an identical title + summary fingerprint, not identical text", () => {
    expect(raw).toMatch(/strictFingerprint/);
    expect(raw).toMatch(/title \+ (RSS )?(description|summary)/i);
    expect(raw).toMatch(/article body is not compared/i);
    expect(raw).not.toMatch(/byte-identical/i);
    expect(raw).not.toMatch(/outlet's text/i);
  });

  // ---- functions: shape + security ----------------------------------------

  it("creates exactly two functions, both SECURITY DEFINER with an empty search_path", () => {
    expect(Object.keys(fns).sort()).toEqual([
      "source_karne_refresh_batch",
      "source_reliability_refresh_source",
    ]);
    expect([...code.matchAll(/create\s+or\s+replace\s+function\b/gi)]).toHaveLength(2);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(2);
    expect([...code.matchAll(/search_path\s*=\s*''/gi)]).toHaveLength(2);
  });

  it("the per-source function has the (uuid, integer default 30) -> boolean signature", () => {
    expect(collapse(fns.source_reliability_refresh_source!.args)).toBe(
      "p_source_id uuid, p_days integer default 30",
    );
    expect(fns.source_reliability_refresh_source!.returns).toBe("boolean");
  });

  it("the re-created batch keeps 106's argument list (defaults) and return type", () => {
    const b106 = fns106.source_karne_refresh_batch;
    expect(b106, "106's batch must parse").toBeDefined();
    expect(collapse(fns.source_karne_refresh_batch!.args)).toBe(collapse(b106!.args));
    expect(fns.source_karne_refresh_batch!.returns).toBe(b106!.returns);
  });

  it.each([
    ["source_reliability_refresh_source", "uuid\\s*,\\s*integer"],
    ["source_karne_refresh_batch", "integer\\s*,\\s*integer\\s*,\\s*integer"],
  ])("revokes %s from public/anon/authenticated and grants service_role only", (name, sig) => {
    expect(code).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\s*\\(\\s*${sig}\\s*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`,
        "i",
      ),
    );
    expect(code).toMatch(
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\s*\\(\\s*${sig}\\s*\\)\\s+to\\s+service_role\\s*;`,
        "i",
      ),
    );
  });

  it("never grants anything to anon/authenticated", () => {
    expect(code).not.toMatch(
      /grant\s+[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i,
    );
  });

  it("comments both functions and the table", () => {
    expect(code).toMatch(/comment\s+on\s+table\s+public\.source_reliability_30d\s+is/i);
    expect(code).toMatch(
      /comment\s+on\s+function\s+public\.source_reliability_refresh_source\s*\(\s*uuid\s*,\s*integer\s*\)\s+is/i,
    );
    expect(code).toMatch(
      /comment\s+on\s+function\s+public\.source_karne_refresh_batch\s*\(\s*integer\s*,\s*integer\s*,\s*integer\s*\)\s+is/i,
    );
  });

  // ---- table ---------------------------------------------------------------

  describe("public.source_reliability_30d", () => {
    it("is created with the pinned columns and checks", () => {
      const m = code.match(
        /create\s+table\s+if\s+not\s+exists\s+public\.source_reliability_30d\s*\(([\s\S]*?)\n\);/i,
      );
      expect(m, "create table block").not.toBeNull();
      const t = collapse(m![1]!);
      expect(t).toMatch(
        /source_id uuid primary key references public\.sources\(id\) on delete cascade/,
      );
      expect(t).toMatch(/window_days int not null check \(window_days between 1 and 90\)/);
      expect(t).toMatch(/window_start timestamptz not null/);
      expect(t).toMatch(/window_end timestamptz not null/);
      expect(t).toMatch(/n_articles int not null check \(n_articles >= 0\)/);
      expect(t).toMatch(
        /active_days int not null check \(active_days between 0 and window_days \+ 1\)/,
      );
      expect(t).toMatch(/n_clusters int not null check \(n_clusters >= 0\)/);
      expect(t).toMatch(
        /n_wire_copy int not null check \(n_wire_copy between 0 and n_clusters\)/,
      );
      expect(t).toMatch(
        /zone_mix jsonb not null default '\[\]'::jsonb check \(jsonb_typeof\(zone_mix\) = 'array'\)/,
      );
      expect(t).toMatch(/computed_at timestamptz not null default now\(\)/);
    });

    it("enables RLS and strips the Supabase default grants", () => {
      expect(code).toMatch(
        /alter\s+table\s+public\.source_reliability_30d\s+enable\s+row\s+level\s+security\s*;/i,
      );
      expect(code).toMatch(
        /revoke\s+all\s+on\s+public\.source_reliability_30d\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
    });

    it("guards the PG17-only MAINTAIN revoke behind server_version_num >= 170000", () => {
      expect(code).toMatch(/server_version_num'\)::int\s*>=\s*170000/);
      expect(code).toMatch(
        /execute\s+'revoke\s+maintain\s+on\s+public\.source_reliability_30d\s+from\s+anon\s*,\s*authenticated'/i,
      );
      // The only unguarded revoke statements must not mention maintain.
      const unguarded = code.replace(/do\s+\$maint\$[\s\S]*?\$maint\$\s*;/gi, "");
      expect(unguarded).not.toMatch(/\bmaintain\b/i);
    });

    it("grants service_role (and only service_role) table privileges", () => {
      expect(code).toMatch(
        /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+public\.source_reliability_30d\s+to\s+service_role\s*;/i,
      );
      const tableGrants = [...code.matchAll(/grant\s+[^;]*\bon\s+(?:table\s+)?public\.source_reliability_30d\b[^;]*;/gi)];
      expect(tableGrants).toHaveLength(1);
      expect(code).not.toMatch(
        /grant\s+(insert|update|delete|truncate|maintain|all)[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i,
      );
    });
  });

  // ---- per-source function -------------------------------------------------

  describe("source_reliability_refresh_source", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(fns.source_reliability_refresh_source?.body ?? "");
    });

    it("clamps the window to 1..90 and stamps v_end with now()", () => {
      expect(body).toMatch(/least\(greatest\(coalesce\(p_days, 30\), 1\), 90\)/);
      expect(body).toMatch(/v_end timestamptz := pg_catalog\.now\(\)/);
      expect(body).toMatch(
        /v_start := v_end - pg_catalog\.make_interval\(days => v_days\)/,
      );
    });

    it("returns false for a missing or inactive source, true after the upsert", () => {
      expect(body).toMatch(
        /perform 1 from public\.sources where id = p_source_id and active; if not found then return false; end if;/,
      );
      expect(body).toMatch(/return true;\s*end$/);
    });

    it("takes no lock", () => {
      expect(body).not.toMatch(/advisory/i);
    });

    it("cadence counts every in-window, non-future article and distinct Istanbul dates", () => {
      expect(body).toMatch(
        /select pg_catalog\.count\(\*\)::int, pg_catalog\.count\(distinct \(a\.published_at at time zone 'Europe\/Istanbul'\)::date\)::int into v_n_articles, v_active_days from public\.articles a where a\.source_id = p_source_id and a\.published_at >= v_start and a\.published_at <= v_end;/,
      );
    });

    it("zmap pairs equal BIAS_TO_ZONE", () => {
      const m = code.match(
        /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*mine\s+as/i,
      );
      expect(m, "zmap CTE must be present").not.toBeNull();
      const pairs = [
        ...m![1]!.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g),
      ].map((p) => [p[1], p[2]] as const);
      expect(pairs).toHaveLength(Object.keys(BIAS_TO_ZONE).length);
      expect(Object.fromEntries(pairs)).toEqual(BIAS_TO_ZONE);
    });

    it("reuses 106's `mine` CTE and its jsonb_each_text zone lateral verbatim", () => {
      const b106 = collapse(fns106.source_karne_refresh_source!.body);
      const mine =
        "mine as (select distinct ca.cluster_id from public.articles a join public.cluster_articles ca on ca.article_id = a.id where a.source_id = p_source_id and a.published_at >= v_start)";
      expect(b106).toContain(mine);
      expect(body).toContain(mine);
      const lateral =
        "left join lateral (select t.key, (t.value)::int n from pg_catalog.jsonb_each_text(case when pg_catalog.jsonb_typeof(c.bias_distribution)='object' then c.bias_distribution else '{}'::jsonb end) t where t.value ~ '^[0-9]+$') e on true";
      expect(b106).toContain(lateral);
      expect(body).toContain(lateral);
    });

    it("wire rows are deduped to the earliest article per source (dedupeBySource parity)", () => {
      expect(body).toMatch(
        /mem as \(select distinct on \(ca\.cluster_id, a\.source_id\) ca\.cluster_id, a\.source_id, a\.id, a\.content_hash from mine m join public\.cluster_articles ca on ca\.cluster_id = m\.cluster_id join public\.articles a on a\.id = ca\.article_id order by ca\.cluster_id, a\.source_id, a\.published_at asc, a\.id\)/,
      );
    });

    it("treats a NULL content_hash as unique per article (detectWireRedistribution parity)", () => {
      expect(body).toMatch(
        /pg_catalog\.count\(distinct coalesce\(x\.content_hash, 'null:' \|\| x\.id::text\)\)/,
      );
    });

    it("the wire cluster threshold `>= 3` equals wire.ts's `members.length < 3` guard", () => {
      const ts = readFileSync(WIRE_TS, "utf8");
      const tsMin = /members\.length\s*<\s*(\d+)/.exec(ts);
      expect(tsMin, "wire.ts must keep its `members.length < N` guard").not.toBeNull();
      const m = /having pg_catalog\.count\(\*\) >= (\d+) and/.exec(body);
      expect(m, "wire CTE minimum member count").not.toBeNull();
      expect(Number(m![1])).toBe(Number(tsMin![1]));
    });

    it("the unique-hash ratio `<= 0.5` equals WIRE_UNIQUE_HASH_RATIO", () => {
      const m = /::numeric \/ pg_catalog\.count\(\*\) <= ([0-9.]+)\)/.exec(body);
      expect(m, "wire CTE ratio").not.toBeNull();
      expect(Number(m![1])).toBe(WIRE_UNIQUE_HASH_RATIO);
    });

    it("a wire copy is the source's own non-null hash matching ANOTHER source's hash in a wire cluster", () => {
      expect(body).toMatch(
        /copies as \(select o\.cluster_id from mem o join wire w on w\.cluster_id = o\.cluster_id where o\.source_id = p_source_id and o\.content_hash is not null and exists \(select 1 from mem y where y\.cluster_id = o\.cluster_id and y\.source_id <> p_source_id and y\.content_hash = o\.content_hash\)\)/,
      );
    });

    it("the zone-mix floor `zi + zb + zm >= N` equals BALANCE_MIN_SOURCES", () => {
      const m = /from zc where zi \+ zb \+ zm >= (\d+) group by zi, zb, zm/.exec(body);
      expect(m, "mix CTE floor").not.toBeNull();
      expect(Number(m![1])).toBe(BALANCE_MIN_SOURCES);
    });

    it("writes the zone mix as [zi, zb, zm, n] triples and no entropy", () => {
      expect(body).toMatch(
        /pg_catalog\.jsonb_agg\(pg_catalog\.jsonb_build_array\(zi, zb, zm, n\) order by n desc, zi, zb, zm\)/,
      );
      expect(body).not.toMatch(/\bln\(|\blog\(|entropy/i);
    });

    it("upserts every column keyed on source_id", () => {
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

  // ---- batch function ------------------------------------------------------

  describe("source_karne_refresh_batch (re-created)", () => {
    let body = "";
    let body106 = "";
    beforeAll(() => {
      body = collapse(fns.source_karne_refresh_batch?.body ?? "");
      body106 = collapse(fns106.source_karne_refresh_batch?.body ?? "");
    });

    it("keeps the same advisory lock as 096/106 and returns 0 when it is held", () => {
      const lock =
        "if not pg_catalog.pg_try_advisory_xact_lock( pg_catalog.hashtext('source_karne_refresh')::bigint ) then return 0; end if;";
      expect(body106).toContain(lock);
      expect(body).toContain(lock);
    });

    it("keeps the 1..90 / 1..200 / 1000..600000 clamps and the budget exit", () => {
      expect(body).toMatch(/least\(greatest\(coalesce\(p_days, 30\), 1\), 90\)/);
      expect(body).toMatch(/least\(greatest\(coalesce\(p_limit, 10\), 1\), 200\)/);
      expect(body).toMatch(
        /least\(greatest\(coalesce\(p_budget_ms, 120000\), 1000\), 600000\)/,
      );
      expect(body).toMatch(/v_started timestamptz := pg_catalog\.clock_timestamp\(\)/);
      expect(body).toMatch(/exit when v_done >= v_limit or /);
      expect(body).toMatch(
        /pg_catalog\.clock_timestamp\(\) - v_started > pg_catalog\.make_interval\(secs => v_budget_ms \/ 1000\.0\)/,
      );
    });

    it("selects active sources whose karne OR reliability row is missing or older than 20 hours", () => {
      expect(body).toMatch(/interval '20 hours'/);
      expect(body).toMatch(
        /left join public\.source_karne_30d k on k\.source_id = s\.id left join public\.source_reliability_30d r on r\.source_id = s\.id where s\.active/,
      );
      expect(body).toMatch(
        /\(k\.source_id is null or k\.computed_at < pg_catalog\.now\(\) - interval '20 hours'\) as karne_due/,
      );
      expect(body).toMatch(
        /\(r\.source_id is null or r\.computed_at < pg_catalog\.now\(\) - interval '20 hours'\) as rel_due/,
      );
      expect(body).toMatch(
        /order by least\(coalesce\(k\.computed_at, '-infinity'::timestamptz\), coalesce\(r\.computed_at, '-infinity'::timestamptz\)\) asc, s\.id/,
      );
    });

    it("isolates each refresh call in its own `exception when others` block (exactly two)", () => {
      expect([...body.matchAll(/exception when others/g)]).toHaveLength(2);
      expect(body).toMatch(
        /if v_src\.karne_due then begin perform public\.source_karne_refresh_source\(v_src\.id, v_days\); v_ok := true; exception when others then raise log 'source_karne_refresh_batch: karne of source % failed: % \(%\)', v_src\.id, sqlerrm, sqlstate; end; end if;/,
      );
      expect(body).toMatch(
        /if v_src\.rel_due then begin perform public\.source_reliability_refresh_source\(v_src\.id, v_days\); v_ok := true; exception when others then raise log 'source_karne_refresh_batch: reliability of source % failed: % \(%\)', v_src\.id, sqlerrm, sqlstate; end; end if;/,
      );
    });

    it("counts a source toward the limit only when at least one refresh succeeded", () => {
      expect(body).toMatch(/v_ok := false;/);
      expect(body).toMatch(/if v_ok then v_done := v_done \+ 1; end if;/);
      // The counter is not bumped anywhere else.
      expect([...body.matchAll(/v_done := v_done \+ 1/g)]).toHaveLength(1);
    });

    it("deletes karne AND reliability rows of inactive or removed sources, then returns the count", () => {
      expect(body).toMatch(
        /delete from public\.source_karne_30d k where not exists \(select 1 from public\.sources s where s\.id = k\.source_id and s\.active\);/,
      );
      expect(body).toMatch(
        /delete from public\.source_reliability_30d r where not exists \(select 1 from public\.sources s where s\.id = r\.source_id and s\.active\);/,
      );
      expect(body).toMatch(/return v_done; end$/);
    });
  });

  // ---- hygiene -------------------------------------------------------------

  it("does not touch pg_cron: no schedule, no unschedule (the */15 job is unchanged)", () => {
    expect(code).not.toMatch(/cron\.schedule/i);
    expect(code).not.toMatch(/cron\.unschedule/i);
    expect(code).not.toMatch(/\bcron\./i);
  });

  it("does not run any backfill at the top level", () => {
    const topLevel = code.replace(/\$fn\$[\s\S]*?\$fn\$/g, "");
    expect(topLevel).not.toMatch(/\bselect\s+public\.source_/i);
    expect(topLevel).not.toMatch(/\bperform\s+public\.source_/i);
  });

  it("leaves 096/106's other objects alone: no manual-pass or per-source karne redefinition, no drop, no alter of existing tables", () => {
    expect(code).not.toMatch(/function\s+public\.source_karne_refresh\s*\(/i);
    expect(code).not.toMatch(/function\s+public\.source_karne_refresh_source\s*\(/i);
    expect(code).not.toMatch(/\bdrop\s+\w+/i);
    expect(code).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/create\s+policy/i);
    const alters = [...code.matchAll(/\balter\s+table\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(alters).toEqual(["public.source_reliability_30d"]);
  });

  it("writes the ledger row", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'111'\s*,\s*'111_source_reliability'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });
});
