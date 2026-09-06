import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  BIAS_TO_ZONE,
  BIAS_KEYS,
  ZONE_KEYS,
  BLINDSPOT,
  type BiasKey,
  type MediaDnaZone,
} from "../../supabase/functions/_shared/cluster/blindspot";
import {
  SOURCE_KINDS,
  VOTING_SOURCE_KINDS,
  DEFAULT_SOURCE_KIND,
} from "../../supabase/functions/_shared/cluster/source-kind";

// Strips `--` line comments so header/prose comments can't satisfy regex
// assertions meant to guard actual SQL. Comment content is genuinely absent
// from the result the assertions run against — see the sanity check below.
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

// ---------------------------------------------------------------------------
// Production had FOUR contradictory blindspot definitions before the
// bias-zone contract (supabase/functions/_shared/cluster/blindspot.ts). Two
// of them were hand-written SQL copies of the zone map: migration 023 (the
// /trends histogram view) and migration 032 (the blindspot recompute).
// Migration 031 carries an equivalent but structurally different copy (a
// per-zone `in (...)` category list rather than a CASE) — kept here for
// history since it's the previous DB-level rule. This file fails the build
// the moment any of those SQL copies drifts from the contract module, and
// fails again if a future migration introduces yet another undeclared copy.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

// Parses `when 'key' then 'zone'` pairs out of a SQL CASE expression into a
// BIAS_TO_ZONE-shaped record.
function parseZoneCase(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /when\s+'([a-z_]+)'\s+then\s+'([a-z]+)'/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

// Parses migration 031's shape: three `filter (where v.k in (...)) as
// <zone>` blocks, each listing the bias categories that roll up into that
// zone. Returns the same BIAS_TO_ZONE-shaped record as parseZoneCase.
function parseZoneFilterLists(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /filter\s*\(\s*where\s+v\.k\s+in\s*\(([^)]+)\)\s*\)\s*,\s*0\)\s+as\s+(iktidar|bagimsiz|muhalefet)/gis;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const list = m[1] as string;
    const zone = m[2] as string;
    const keyRe = /'([a-z_]+)'/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(list)) !== null) {
      out[km[1] as string] = zone;
    }
  }
  return out;
}

// Extracts every `array['a','b',...]` literal in the SQL and returns the
// ones with exactly `length` elements, in source order, as string arrays.
function extractArrayLiterals(sql: string, length: number): string[][] {
  const out: string[][] = [];
  const re = /array\s*\[([\s\S]*?)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const body = m[1] as string;
    const items: string[] = [];
    const itemRe = /'([a-z_]+)'/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(body)) !== null) {
      items.push(im[1] as string);
    }
    if (items.length === length) out.push(items);
  }
  return out;
}

// Extracts every `in (...)` list of quoted identifiers in the SQL (e.g. the
// `where e.key in ('pro_government', ...)` total filter in 032).
function extractInLists(sql: string): string[][] {
  const out: string[][] = [];
  const re = /\bin\s*\(([^)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const body = m[1] as string;
    const itemRe = /'([a-z_]+)'/g;
    const items: string[] = [];
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(body)) !== null) {
      items.push(im[1] as string);
    }
    if (items.length > 0) out.push(items);
  }
  return out;
}

const contractZoneMap: Record<string, string> = { ...BIAS_TO_ZONE };

describe("zone-parity: migration 023 (trends histogram) matches the contract", () => {
  it("its zone CASE deep-equals BIAS_TO_ZONE", () => {
    const sql = read("023_trends_daily_histogram.sql");
    const parsed = parseZoneCase(sql);
    expect(parsed).toEqual(contractZoneMap);
  });
});

describe("zone-parity: migration 032 (blindspot recompute) matches the contract", () => {
  let sql = "";
  let code = "";
  beforeAll(() => {
    sql = read("032_blindspot_contract_recompute.sql");
    expect(sql.length).toBeGreaterThan(0);
    code = stripSqlComments(sql);
  });

  it("its zone CASE deep-equals BIAS_TO_ZONE", () => {
    const parsed = parseZoneCase(code);
    expect(parsed).toEqual(contractZoneMap);
  });

  it("every `in (...)` bias-key list deep-equals the BIAS_KEYS set", () => {
    const lists = extractInLists(code);
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(new Set(list)).toEqual(new Set(BIAS_KEYS));
    }
  });

  it("its BIAS_KEYS-order array literal equals BIAS_KEYS", () => {
    const candidates = extractArrayLiterals(code, BIAS_KEYS.length);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate).toEqual([...BIAS_KEYS]);
    }
  });

  it("its ZONE_KEYS-order array literal equals ZONE_KEYS", () => {
    const candidates = extractArrayLiterals(code, ZONE_KEYS.length);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate).toEqual([...ZONE_KEYS]);
    }
  });

  it("contains the BLINDSPOT.minSources / dominantShare literals, anchored to the real expressions (not hardcoded here)", () => {
    const minSourcesRe = new RegExp(`t\\.total\\s*>=\\s*${BLINDSPOT.minSources}\\b`);
    const shareRe = new RegExp(
      `nullif\\(t\\.total,\\s*0\\)\\s*>=\\s*${BLINDSPOT.dominantShare
        .toString()
        .replace(".", "\\.")}\\b`,
    );
    expect(code).toMatch(minSourcesRe);
    expect(code).toMatch(shareRe);
  });

  it("calls itself exactly once as the documented backfill", () => {
    const matches = code.match(/select\s+public\.recompute_blindspot_flags\(\)\s*;/gi);
    expect(matches).toHaveLength(1);
  });

  it("sanity: comment-stripping is non-vacuous (the raw file has more matches than the stripped one)", () => {
    const rawBackfillMatches =
      sql.match(/select\s+public\.recompute_blindspot_flags\(\)\s*;/gi) ?? [];
    const strippedBackfillMatches =
      code.match(/select\s+public\.recompute_blindspot_flags\(\)\s*;/gi) ?? [];
    expect(rawBackfillMatches.length).toBeGreaterThan(strippedBackfillMatches.length);
  });
});

describe("zone-parity: migration 031 (history) matches the contract", () => {
  it("its per-zone filter category lists deep-equal BIAS_TO_ZONE", () => {
    const sql = read("031_zone_based_blindspot_backfill.sql");
    const parsed = parseZoneFilterLists(sql);
    expect(parsed).toEqual(contractZoneMap);
  });
});

// ---------------------------------------------------------------------------
// Migration 034 introduces a second, independent contract — source kind
// (supabase/functions/_shared/cluster/source-kind.ts) — alongside the
// existing bias-zone contract. Both are asserted against the same file:
// the zone CASE in the recreated trends_daily_bias_counts view still has
// to match BIAS_TO_ZONE, and the new kind machinery (CHECK constraint,
// default, voting filters, jsonb key order, function grants, call order)
// has to match SOURCE_KINDS / VOTING_SOURCE_KINDS / DEFAULT_SOURCE_KIND —
// plus parity against supabase/seed_sources.sql's (slug, kind) pairs.
// ---------------------------------------------------------------------------

// Parses the quoted-string list inside `check (kind in (...))`.
function parseKindCheckList(sql: string): string[] {
  const m = /check\s*\(\s*kind\s+in\s*\(([^)]+)\)\s*\)/i.exec(sql);
  if (!m) return [];
  const body = m[1] as string;
  const items: string[] = [];
  const itemRe = /'([a-z_]+)'/g;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(body)) !== null) items.push(im[1] as string);
  return items;
}

// Parses the `'key',` literals inside a `jsonb_build_object( ... ) as dist`
// span, in source order. A trailing `)` before the comma (the FILTER's
// closing paren, e.g. `= 'pro_government'),`) means the quote is NOT
// immediately followed by a comma, so only true key positions match.
function parseDistKeys(sql: string): string[] {
  const span = /jsonb_build_object\(([\s\S]*?)\)\s+as\s+dist/i.exec(sql);
  if (!span) return [];
  const body = span[1] as string;
  const keys: string[] = [];
  const keyRe = /'([a-z_]+)',/g;
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(body)) !== null) keys.push(km[1] as string);
  return keys;
}

// Parses the (slug, kind) VALUES pairs from 034's `from (values ...) as
// v(slug, kind)` span.
function parse034SlugKindPairs(sql: string): Array<[string, string]> {
  const span = /from\s*\(\s*values([\s\S]*?)\)\s*as\s*v\(slug,\s*kind\)/i.exec(sql);
  if (!span) return [];
  const body = span[1] as string;
  const pairs: Array<[string, string]> = [];
  const pairRe = /\(\s*'([a-z0-9-]+)'\s*,\s*'([a-z]+)'\s*\)/g;
  let pm: RegExpExecArray | null;
  while ((pm = pairRe.exec(body)) !== null) {
    pairs.push([pm[1] as string, pm[2] as string]);
  }
  return pairs;
}

// Parses seed_sources.sql tuples: ('name', 'slug', 'url', 'rss', 'bias',
// 'kind', true|false). Returns (slug, bias, kind) triples.
function parseSeedRows(sql: string): Array<{ slug: string; bias: string; kind: string }> {
  const rowRe =
    /\('(?:[^'\\]|\\.)*',\s*'([a-z0-9-]+)',\s*'(?:[^'\\]|\\.)*',\s*'(?:[^'\\]|\\.)*',\s*'([a-z_]+)',\s*'([a-z]+)',\s*(?:true|false)\)/g;
  const rows: Array<{ slug: string; bias: string; kind: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(sql)) !== null) {
    rows.push({ slug: m[1] as string, bias: m[2] as string, kind: m[3] as string });
  }
  return rows;
}

const SEED_PATH = resolve(__dirname, "..", "..", "supabase", "seed_sources.sql");

describe("zone-parity: migration 034 (source kind) matches the contracts", () => {
  let sql = "";
  let code = "";
  beforeAll(() => {
    sql = read("034_source_kind.sql");
    expect(sql.length).toBeGreaterThan(0);
    code = stripSqlComments(sql);
  });

  it("its zone CASE (trends view recreation) deep-equals BIAS_TO_ZONE", () => {
    const parsed = parseZoneCase(code);
    expect(parsed).toEqual(contractZoneMap);
  });

  it("the CHECK constraint's kind list equals the SOURCE_KINDS set", () => {
    const parsed = parseKindCheckList(code);
    expect(parsed.length).toBeGreaterThan(0);
    expect(new Set(parsed)).toEqual(new Set(SOURCE_KINDS));
  });

  it("the column default matches DEFAULT_SOURCE_KIND", () => {
    const defaultRe = new RegExp(`default\\s+'${DEFAULT_SOURCE_KIND}'`);
    expect(code).toMatch(defaultRe);
  });

  it("every `in (...)` list is either the SOURCE_KINDS set or the VOTING_SOURCE_KINDS set, with >=2 voting lists and no other shape", () => {
    const lists = extractInLists(code);
    expect(lists.length).toBeGreaterThan(0);
    let sourceKindLists = 0;
    let votingLists = 0;
    for (const list of lists) {
      const set = new Set(list);
      if (JSON.stringify([...set].sort()) === JSON.stringify([...new Set(SOURCE_KINDS)].sort())) {
        sourceKindLists += 1;
      } else if (
        JSON.stringify([...set].sort()) === JSON.stringify([...new Set(VOTING_SOURCE_KINDS)].sort())
      ) {
        votingLists += 1;
      } else {
        throw new Error(`unexpected in (...) list shape: ${JSON.stringify(list)}`);
      }
    }
    expect(sourceKindLists).toBe(1);
    expect(votingLists).toBeGreaterThanOrEqual(2);
  });

  it("the jsonb_build_object key literals equal BIAS_KEYS in order", () => {
    const keys = parseDistKeys(code);
    expect(keys).toEqual([...BIAS_KEYS]);
  });

  it("calls recompute_bias_distribution exactly once, before the single recompute_blindspot_flags call", () => {
    const biasCalls = [...code.matchAll(/select\s+public\.recompute_bias_distribution\(/gi)];
    const flagCalls = [...code.matchAll(/select\s+public\.recompute_blindspot_flags\(\)\s*;/gi)];
    expect(biasCalls).toHaveLength(1);
    expect(flagCalls).toHaveLength(1);
    expect((biasCalls[0] as RegExpMatchArray).index).toBeLessThan(
      (flagCalls[0] as RegExpMatchArray).index as number,
    );
  });

  it("revokes recompute_bias_distribution from anon/authenticated/public and grants it to service_role", () => {
    expect(code).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.recompute_bias_distribution\(timestamptz\)\s*\n?\s*from\s+anon,\s*authenticated,\s*public/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.recompute_bias_distribution\(timestamptz\)\s+to\s+service_role/i,
    );
  });

  it("the recreated trends_daily_bias_counts view filters by kind", () => {
    expect(code).toMatch(/create\s+or\s+replace\s+view\s+public\.trends_daily_bias_counts/i);
    expect(code).toMatch(/s\.kind\s+in\s*\(/i);
  });

  describe("seed parity (supabase/seed_sources.sql)", () => {
    let seedSql = "";
    let migrationPairs: Array<[string, string]> = [];
    let seedRows: Array<{ slug: string; bias: string; kind: string }> = [];

    beforeAll(() => {
      seedSql = readFileSync(SEED_PATH, "utf8");
      migrationPairs = parse034SlugKindPairs(code);
      seedRows = parseSeedRows(seedSql);
    });

    it("034's VALUES span is non-empty (sanity: the parser actually found rows)", () => {
      expect(migrationPairs.length).toBeGreaterThan(0);
    });

    it("seed_sources.sql's row parser is non-vacuous (sanity)", () => {
      expect(seedRows.length).toBeGreaterThan(0);
    });

    it("every seed row's kind is a SourceKind", () => {
      for (const row of seedRows) {
        expect(SOURCE_KINDS).toContain(row.kind);
      }
    });

    it("every 034 VALUES kind is a non-outlet SourceKind", () => {
      for (const [, kind] of migrationPairs) {
        expect(SOURCE_KINDS).toContain(kind);
        expect(kind).not.toBe("outlet");
      }
    });

    it("the seed's non-outlet (slug, kind) pairs deep-equal 034's VALUES pairs", () => {
      const seedNonOutlet = seedRows
        .filter((r) => r.kind !== "outlet")
        .map((r): [string, string] => [r.slug, r.kind])
        .sort((a, b) => a[0].localeCompare(b[0]));
      const migrationSorted = [...migrationPairs].sort((a, b) => a[0].localeCompare(b[0]));
      expect(seedNonOutlet).toEqual(migrationSorted);
    });

    it("the seed's insert column list carries `bias, kind, active`", () => {
      expect(seedSql).toMatch(/bias,\s*kind,\s*active/);
    });

    it("the seed's conflict clause updates kind", () => {
      expect(seedSql).toMatch(/kind\s*=\s*excluded\.kind/);
    });
  });
});

describe("zone-parity: cluster-consumer imports the contract module", () => {
  it("imports from ../_shared/cluster/blindspot.ts", () => {
    const indexPath = resolve(
      __dirname,
      "..",
      "..",
      "supabase",
      "functions",
      "cluster-consumer",
      "index.ts",
    );
    const src = readFileSync(indexPath, "utf8");
    expect(src).toMatch(/from\s+"\.\.\/_shared\/cluster\/blindspot\.ts"/);
  });

  it("imports from ../_shared/cluster/source-kind.ts", () => {
    const indexPath = resolve(
      __dirname,
      "..",
      "..",
      "supabase",
      "functions",
      "cluster-consumer",
      "index.ts",
    );
    const src = readFileSync(indexPath, "utf8");
    expect(src).toMatch(/from\s+"\.\.\/_shared\/cluster\/source-kind\.ts"/);
  });
});

describe("zone-parity: no undeclared zone-map copy exists in the migrations directory", () => {
  it("every migration mentioning 'iktidar' is one of the four known copies", () => {
    const KNOWN_FILES = new Set([
      "023_trends_daily_histogram.sql",
      "031_zone_based_blindspot_backfill.sql",
      "032_blindspot_contract_recompute.sql",
      "034_source_kind.sql",
    ]);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter(
      (f) => read(f).includes("iktidar") && !KNOWN_FILES.has(f),
    );
    expect(offenders).toEqual([]);

    // Sanity: the known files really do mention it (regex isn't vacuous).
    for (const f of KNOWN_FILES) {
      expect(read(f)).toMatch(/iktidar/);
    }
  });
});

// Type-only assertions so this file also breaks if the contract's exported
// shapes change in ways the runtime checks above wouldn't catch.
function _typeCheck(k: BiasKey): MediaDnaZone {
  return BIAS_TO_ZONE[k];
}
void _typeCheck;
