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
});

describe("zone-parity: no undeclared zone-map copy exists in the migrations directory", () => {
  it("every migration mentioning 'iktidar' is one of the three known copies", () => {
    const KNOWN_FILES = new Set([
      "023_trends_daily_histogram.sql",
      "031_zone_based_blindspot_backfill.sql",
      "032_blindspot_contract_recompute.sql",
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
