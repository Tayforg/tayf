import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 174 ("bist-quote-stats-unit-guard"), h67-edgefns-1.
//
// public.bist_quote_stats gave /ekonomi its relative volume as the last session's volume over the average of the 20
// rows before it, with no unit or zero handling. quotes-ingest keeps only rows with day >= last_day, so older rows
// Yahoo has since split-adjusted stay frozen in the old unit, and a halt placeholder (a flat bar with volume 0) is
// stored as a real row. On 2026-11-08 MERCN (a 3.00004-for-1 split on 10-30) read 1.73 against a true 0.82 and DUNYH
// (19 of 20 prior rows flat at 109.10 with volume 0) read 7.51 in amber. 174 nulls avg_volume_20 AND rvol when the
// 20-session window crosses a unit break (a close step outside 0.75 .. 1.35 of the previous close, BIST's band is
// +-10 percent), holds fewer than 10 real volumes, or when the last volume is not a real volume; the zero-volume rows
// of a clean window stay out of the average.
//
// This file pins: the statements (one transaction, lock_timeout, create or replace view WITH security_invoker, the
// repeated alter view, the grants production has, the ledger row), the view body's thresholds and frames, the header,
// the docs section, the live manifest and the dry-run. The live block at the end runs the view against bar fixtures
// through psql when TAYF_PSQL is set (every case rolled back).
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION_174 = resolve(ROOT, "supabase", "migrations", "174_bist_quote_stats_unit_guard.sql");
const DOC_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "174-bist-quote-stats-unit-guard-dryrun.sql");

/** Production, read-only, 2026-11-08: md5 and length of pg_get_viewdef('public.bist_quote_stats'::regclass, true) before 174. */
const PROD_VIEWDEF_MD5_BEFORE = "8f5ecc5369051b3b9405e23a6376c68c";
const PROD_VIEWDEF_LENGTH_BEFORE = 880;

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('174', '174_bist_quote_stats_unit_guard') on conflict do nothing";

/** The columns of the view, in order, with the types production has (pg_attribute, format_type). */
const COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["ticker", "text"],
  ["last_day", "date"],
  ["last_close", "numeric(14,4)"],
  ["prev_close", "numeric"],
  ["last_volume", "bigint"],
  ["avg_volume_20", "numeric"],
  ["rvol", "numeric"],
];

// -- character-scan helpers (no regular expression runs over SQL text) ----------

/** Removes `--` comments (to the end of the line, newline kept); quoted strings are copied verbatim. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" && sql.charAt(i + 1) === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Splits comment-free SQL on `;`, not inside a quoted string. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ";") {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const collapse = (s: string): string => s.replaceAll("\n", " ").split(" ").filter(Boolean).join(" ");

/** Identifier-like words of the text, lower case. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || ch === "_" || (ch >= "0" && ch <= "9")) {
      cur += ch;
    } else if (cur) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** How many times `needle` occurs in `text` (non-overlapping). */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const raw = readFileSync(MIGRATION_174, "utf8");
const code = stripComments(raw);
const statements = splitStatements(code).map(collapse);
const viewStmt = statements[2] ?? "";

describe("174 statements", () => {
  it("is one transaction: begin, lock_timeout, the view, the repeated alter view, the grants, the ledger row, commit", () => {
    expect(statements).toHaveLength(7);
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toBe("set local lock_timeout = '5s'");
    expect(viewStmt.startsWith("create or replace view public.bist_quote_stats with (security_invoker = on) as ")).toBe(true);
    expect(statements[3]).toBe("alter view public.bist_quote_stats set (security_invoker = on)");
    expect(statements[4]).toBe("grant all on public.bist_quote_stats to service_role");
    expect(statements[5]).toBe(LEDGER_STMT);
    expect(statements[6]).toBe("commit");
  });

  it("sets security_invoker in the WITH list and again with alter view (a replace without the list would clear the option)", () => {
    expect(countOf(code, "security_invoker = on")).toBe(2);
    // order, on the comment-free code (the header mentions both phrases too)
    expect(code.indexOf("with (security_invoker = on)")).toBeGreaterThan(code.indexOf("create or replace view"));
    expect(code.indexOf("alter view public.bist_quote_stats set (security_invoker = on);")).toBeGreaterThan(code.indexOf("with (security_invoker = on)"));
  });

  it("changes no table and no data: no update, delete, drop, truncate, create table, alter table; the only insert is the ledger row", () => {
    const words = wordsOf(code);
    for (const w of ["update", "delete", "drop", "truncate"]) expect(words, w).not.toContain(w);
    expect(countOf(collapse(code), "create table")).toBe(0);
    expect(countOf(collapse(code), "alter table")).toBe(0);
    expect(countOf(collapse(code), "create or replace view")).toBe(1);
    expect(words.filter((w) => w === "insert")).toHaveLength(1);
    expect(statements.filter((s) => s.startsWith("insert ")).map((s) => s)).toEqual([LEDGER_STMT]);
  });

  it("grants nothing to anon, authenticated or public (117 closed that surface); the one grant is production's service_role ACL", () => {
    const grants = statements.filter((s) => s.startsWith("grant "));
    expect(grants).toEqual(["grant all on public.bist_quote_stats to service_role"]);
    for (const w of ["anon", "authenticated"]) expect(wordsOf(code), w).not.toContain(w);
    expect(code).not.toContain("to public");
  });

  it("records itself in the ledger exactly once", () => {
    expect(countOf(raw, "insert into supabase_migrations.schema_migrations")).toBe(1);
    expect(countOf(raw, "'174_bist_quote_stats_unit_guard'")).toBe(1);
  });
});

describe("174 view body", () => {
  const body = collapse(viewStmt);

  it("reads only public.bist_bars_daily", () => {
    expect(countOf(body, "from public.bist_bars_daily ")).toBe(1);
    expect(countOf(body, " from public.")).toBe(1);
    expect(countOf(body, " join ")).toBe(0);
  });

  it("CTE b: prev_close is lag(close) and a unit break is a close step outside 0.75 .. 1.35 of the previous close (guarded, never divides by 0)", () => {
    expect(body).toContain("lag(close) over w as prev_close");
    expect(body).toContain("when lag(close) over w > 0");
    expect(body).toContain("close / lag(close) over w < 0.75");
    expect(body).toContain("close / lag(close) over w > 1.35");
    expect(body).toContain("as unit_break");
    // the thresholds appear once each and no other price band is in the body
    expect(countOf(body, "0.75")).toBe(1);
    expect(countOf(body, "1.35")).toBe(1);
    // the division sits inside the CASE branch that tests the divisor first
    expect(body.indexOf("when lag(close) over w > 0")).toBeLessThan(body.indexOf("close / lag(close) over w < 0.75"));
  });

  it("CTE ranked: the break frame is 19 preceding .. current row, the volume frame is 20 preceding .. 1 preceding, real volumes only", () => {
    expect(body).toContain("bool_or(unit_break) over (w rows between 19 preceding and current row) as break_in_window");
    expect(body).toContain("avg(volume) filter (where volume > 0) over (w rows between 20 preceding and 1 preceding) as avg_nz");
    expect(body).toContain("count(*) filter (where volume > 0) over (w rows between 20 preceding and 1 preceding) as n_nz");
    expect(body).toContain("row_number() over (partition by ticker order by day desc) as rn");
    expect(countOf(body, "rows between 20 preceding and 1 preceding")).toBe(2);
    expect(countOf(body, "rows between 19 preceding and current row")).toBe(1);
    expect(body).not.toContain("unbounded");
  });

  it("keeps the partition-by-ticker shape in every window so a ticker filter still pushes down", () => {
    expect(countOf(body, "window w as (partition by ticker order by day)")).toBe(2);
    expect(countOf(body, "partition by ticker")).toBe(3);
    // every `over` is the named window w or an explicit partition by ticker
    const overs = body.split(" over ").slice(1);
    for (const o of overs) expect(o.startsWith("w ") || o.startsWith("w)") || o.startsWith("(w rows") || o.startsWith("(partition by ticker"), o.slice(0, 40)).toBe(true);
  });

  it("outputs the row with rn = 1, prev_close unchanged (session.ts rebaseQuoteOnStat depends on it)", () => {
    expect(body).toContain("where rn = 1");
    expect(body).toContain("close as last_close, prev_close, volume as last_volume");
    expect(body).toContain("day as last_day");
  });

  it("nulls avg_volume_20 when the window has a break, fewer than 10 real volumes, or the last volume is null or not above 0", () => {
    expect(body).toContain("when break_in_window or n_nz < 10 or volume is null or volume <= 0 then null else avg_nz end as avg_volume_20");
    expect(countOf(body, "n_nz < 10")).toBe(1);
  });

  it("derives rvol from that nulled avg_volume_20, so the two are null under the same condition", () => {
    expect(body).toContain("case when avg_volume_20 > 0 then round(last_volume::numeric / avg_volume_20, 2) end as rvol");
    // rvol is computed in the select over the CTE that already nulls the average, never from avg_nz
    expect(body.indexOf("as avg_volume_20")).toBeLessThan(body.indexOf("as rvol"));
    const rvolAt = body.indexOf("end as rvol");
    expect(body.slice(rvolAt)).toContain("from last_row");
    expect(countOf(body, "avg_nz")).toBe(2);
  });

  it("outputs the same seven columns in the same order", () => {
    const outer = body.slice(body.lastIndexOf(" select ticker, last_day, last_close, prev_close, last_volume, avg_volume_20, "));
    expect(outer.startsWith(" select ticker, last_day, last_close, prev_close, last_volume, avg_volume_20, case when")).toBe(true);
    expect(COLUMNS.map((c) => c[0])).toEqual(["ticker", "last_day", "last_close", "prev_close", "last_volume", "avg_volume_20", "rvol"]);
  });
});

describe("174 header documents the change", () => {
  let header = "";
  beforeAll(() => {
    header = raw.slice(0, raw.indexOf("\nbegin;"));
  });

  it("names the finding, the evidence and the sections", () => {
    expect(header).toMatch(/^-- 174_bist_quote_stats_unit_guard\.sql/);
    for (const word of ["h67-edgefns-1", "MERCN", "1.73", "0.82", "DUNYH", "7.51", "SKBNK", "SASA", "quotes-ingest", "WHY", "WHAT CHANGES"]) {
      expect(header, word).toContain(word);
    }
  });

  it("records the production view fingerprint it replaces, the grants it keeps, the replay and the dry run", () => {
    expect(header).toContain(PROD_VIEWDEF_MD5_BEFORE);
    expect(header).toContain(String(PROD_VIEWDEF_LENGTH_BEFORE));
    expect(header).toContain("security_invoker=on");
    expect(header).toContain("service_role=arwdDxtm/postgres");
    expect(header).toContain("REPLAY");
    expect(header).toContain("DRY RUN");
    expect(header).toContain("DRYRUN 174 OK");
  });

  it("states the deploy order (apply only), the verify queries and a rollback that restores 051's view", () => {
    expect(header).toContain("APPLY 174 ONLY");
    expect(header).toContain("VERIFY (read-only");
    const rb = header.slice(header.indexOf("ROLLBACK"));
    expect(rb).toContain("051_finance_bars_and_speed.sql");
    expect(rb).toContain("security_invoker");
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '174'");
  });

  it("says what stays out: no history restate, no quotes-ingest change, no UI copy change", () => {
    expect(header).toContain("OUT OF SCOPE");
    expect(header).toContain("full");
    expect(header).toContain("bars.ts");
  });
});

describe("174 docs", () => {
  const guide = readFileSync(DOC_GUIDE, "utf8");
  const at = guide.indexOf("\n## 174 ");
  const section = at < 0 ? "" : guide.slice(at, guide.indexOf("\n## ", at + 5) < 0 ? guide.length : guide.indexOf("\n## ", at + 5));

  it("has a migration-guide section 174 with the apply order", () => {
    expect(at).toBeGreaterThan(0);
    expect(section.split("\n")[1]).toContain("174");
    expect(section).toContain("APPLY 174");
  });

  it("names the evidence, the rule and the verify and rollback steps", () => {
    for (const word of [
      "h67-edgefns-1",
      "MERCN",
      "DUNYH",
      "bist_quote_stats",
      "security_invoker",
      "0.75",
      "1.35",
      "19 preceding",
      "n_nz < 10",
      "avg_volume_20",
      "Verify",
      "Rollback",
      "ticker-chip.tsx",
    ]) {
      expect(section, word).toContain(word);
    }
  });
});

describe("174 live manifest and dry-run", () => {
  it("builds 174's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 174-bist-quote-stats-unit-guard.test.ts"));
    expect(lines).toHaveLength(1);
    const setup = (lines[0] as string).split("|")[2] as string;
    expect(setup.trim().split(" ").filter(Boolean)).toEqual(["tests/migrations/sql/174-bist-quote-stats-unit-guard-dryrun.sql"]);
  });

  it("the dry-run builds production's state, applies 174 twice and ends with its OK line", () => {
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "../../../supabase/migrations/174_bist_quote_stats_unit_guard.sql",
      "../../../supabase/migrations/174_bist_quote_stats_unit_guard.sql",
    ]);
    expect(sql).toContain("create table if not exists public.bist_bars_daily");
    expect(sql).toContain("create or replace view public.bist_quote_stats");
    expect(sql).toContain(PROD_VIEWDEF_MD5_BEFORE);
    expect(sql.trimEnd().endsWith("select 'DRYRUN 174 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the view against bar fixtures, on a throwaway Postgres with 174 applied
// (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the
// server. Every case ends in a rollback.
// ---------------------------------------------------------------------------

/** 051's view (production's text before 174) as an inline select: the baseline every unchanged ticker is compared with. */
const OLD_VIEW_SELECT =
  "with ranked as (select ticker, day, close, volume, lag(close) over w as prev_close, " +
  "avg(volume) over (w rows between 20 preceding and 1 preceding) as avg_volume_20, " +
  "row_number() over (partition by ticker order by day desc) as rn from public.bist_bars_daily " +
  "window w as (partition by ticker order by day)) " +
  "select ticker, day as last_day, close as last_close, prev_close, volume as last_volume, avg_volume_20, " +
  "case when avg_volume_20 > 0 then round(volume / avg_volume_20, 2) end as rvol from ranked where rn = 1";

describe.runIf(Boolean(process.env.TAYF_PSQL))("174 bist_quote_stats against bar fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("174", { ledger: ["174"], relations: ["public.bist_bars_daily", "public.bist_quote_stats"] });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  type Bar = { close: number | string; volume: number | null };
  type Row = {
    ticker: string;
    lastDay: string;
    lastClose: string;
    prevClose: string;
    lastVolume: string;
    avg: string;
    rvol: string;
  };

  /** Bars of one ticker on consecutive calendar days (the windows count rows, not days). */
  function bars(ticker: string, rows: readonly Bar[]): string {
    const values = rows.map((b, i) => `('${ticker}', date '2026-01-01' + ${i}, ${b.close}, ${b.volume ?? "null"})`).join(",\n");
    return `insert into public.bist_bars_daily (ticker, day, close, volume) values\n${values};\n`;
  }

  const parse = (out: string): Record<string, Row> => {
    const rows: Record<string, Row> = {};
    for (const line of out.split("\n").filter((l) => l.trim() !== "")) {
      const [ticker, lastDay, lastClose, prevClose, lastVolume, avg, rvol] = line.split("|") as [string, string, string, string, string, string, string];
      rows[ticker] = { ticker, lastDay, lastClose, prevClose, lastVolume, avg, rvol };
    }
    return rows;
  };

  const COLS = "ticker, last_day, last_close, prev_close, last_volume, avg_volume_20, rvol";
  /** The new view over the fixture. */
  const readNew = (fixture: string): Record<string, Row> =>
    parse(runPsql(`begin;\ndelete from public.bist_bars_daily;\n${fixture}\nselect ${COLS} from public.bist_quote_stats order by ticker;\nrollback;\n`));
  /** 051's view over the same fixture. */
  const readOld = (fixture: string): Record<string, Row> =>
    parse(runPsql(`begin;\ndelete from public.bist_bars_daily;\n${fixture}\nselect ${COLS} from (${OLD_VIEW_SELECT}) o order by ticker;\nrollback;\n`));

  const flat = (n: number, close: number, volume: number | null): Bar[] => Array.from({ length: n }, () => ({ close, volume }));
  const get = (rows: Record<string, Row>, t: string): Row => {
    const r = rows[t];
    expect(r, `row for ${t}`).toBeDefined();
    return r as Row;
  };

  /** MERCN before its 10-30 split: closes 8.44 .. 10.54, volumes about 5M. */
  const preSplit = (n: number): Bar[] =>
    Array.from({ length: n }, (_, i) => ({ close: (8.44 + (i % 4) * 0.7).toFixed(4), volume: 5_000_000 + 100_000 * (i % 5) }));
  const POST_CLOSES = [2.81, 2.75, 2.7, 2.78, 2.8, 2.72];

  it("MERCN-shaped (15 rows at 8-11, then 2.81 .. 2.72, 21 rows): avg_volume_20 and rvol are null, the old view said about 1.5", () => {
    const post: Bar[] = POST_CLOSES.map((c, i) => ({ close: c, volume: i === POST_CLOSES.length - 1 ? 8_841_503 : 8_000_000 }));
    const fixture = bars("MERCN", [...preSplit(15), ...post]);
    const r = get(readNew(fixture), "MERCN");
    expect(r.avg).toBe("");
    expect(r.rvol).toBe("");
    expect(r.lastVolume).toBe("8841503");
    expect(r.lastClose).toBe("2.7200");
    expect(r.prevClose).toBe("2.8000");
    const old = get(readOld(fixture), "MERCN");
    expect(old.rvol).not.toBe("");
    expect(Number(old.rvol)).toBeGreaterThan(1.3);
  });

  it("the unit break leaves the window exactly when it is 20 rows back: 36 rows is clean, 35 rows is not", () => {
    const post = (n: number): Bar[] => Array.from({ length: n }, (_, i) => ({ close: 2.8, volume: i === n - 1 ? 10_000_000 : 8_000_000 }));
    // 15 + 21 rows: the break row is the 21st from the end; the 20 averaged rows are all post-split
    const clean = get(readNew(bars("CLEAN", [...preSplit(15), ...post(21)])), "CLEAN");
    expect(clean.rvol).toBe("1.25");
    expect(Number(clean.avg)).toBe(8_000_000);
    // 15 + 20 rows: the break row is the 20th from the end, so the averaged window still holds the last pre-split row
    const mixed = get(readNew(bars("MIXED", [...preSplit(15), ...post(20)])), "MIXED");
    expect(mixed.avg).toBe("");
    expect(mixed.rvol).toBe("");
  });

  it("DUNYH-shaped (19 flat zero-volume rows at 109.10 and one real print, then 11.92): null", () => {
    const prior: Bar[] = [{ close: "109.1000", volume: 17_013_257 }, ...flat(19, 109.1, 0)];
    const r = get(readNew(bars("DUNYH", [...prior, { close: "11.9200", volume: 6_388_000 }])), "DUNYH");
    expect(r.avg).toBe("");
    expect(r.rvol).toBe("");
    expect(r.lastClose).toBe("11.9200");
  });

  it("zero-volume placeholders without any cliff: fewer than 10 real volumes in the window is null, 10 is a value", () => {
    const prior = (real: number): Bar[] => [...flat(real, 11.92, 1_000_000), ...flat(20 - real, 11.92, 0)];
    const nine = get(readNew(bars("NINE", [...prior(9), { close: "11.9200", volume: 2_000_000 }])), "NINE");
    expect(nine.avg).toBe("");
    expect(nine.rvol).toBe("");
    const ten = get(readNew(bars("TEN", [...prior(10), { close: "11.9200", volume: 2_000_000 }])), "TEN");
    expect(Number(ten.avg)).toBe(1_000_000);
    expect(ten.rvol).toBe("2.00");
    // the old view averaged the zeros in: 500000 and 4.00
    expect(Number(get(readOld(bars("TEN", [...prior(10), { close: "11.9200", volume: 2_000_000 }])), "TEN").rvol)).toBe(4);
  });

  it("SASA-shaped (4 zero-volume rows among the 20, no cliff): rvol is the last volume over the average of the 16 real rows", () => {
    const zeros = new Set([3, 7, 11, 15]);
    const prior: Bar[] = Array.from({ length: 20 }, (_, i) => ({
      close: (3.4 + (i % 3) * 0.05).toFixed(4),
      volume: zeros.has(i + 1) ? 0 : 1_000_000 + 10_000 * (i + 1),
    }));
    const real = prior.map((b) => b.volume as number).filter((v) => v > 0);
    expect(real).toHaveLength(16);
    const avg = real.reduce((s, v) => s + v, 0) / real.length;
    const r = get(readNew(bars("SASA", [...prior, { close: "3.4000", volume: 2_500_000 }])), "SASA");
    expect(Number(r.avg)).toBeCloseTo(avg, 4);
    expect(r.rvol).toBe((Math.round((2_500_000 / avg) * 100) / 100).toFixed(2));
    // the old average held the zeros: 16 / 20 of the real one, so its ratio is the larger one (production's SASA: 3.44 against 2.75)
    const old = get(readOld(bars("SASA", [...prior, { close: "3.4000", volume: 2_500_000 }])), "SASA");
    expect(Number(old.avg)).toBeCloseTo(avg * (16 / 20), 4);
    expect(Number(old.rvol)).toBeGreaterThan(Number(r.rvol));
  });

  it("a normal ticker is unchanged against the old formula (all seven columns), at 30, 21 and 12 rows", () => {
    const series = (n: number): Bar[] =>
      Array.from({ length: n }, (_, i) => ({ close: (100 + ((i * 7) % 11) - 5).toFixed(4), volume: 1_000_000 + ((i * 37) % 13) * 50_000 }));
    const fixture = bars("AAA30", series(30)) + bars("BBB21", series(21)) + bars("CCC12", series(12));
    const next = readNew(fixture);
    const old = readOld(fixture);
    for (const t of ["AAA30", "BBB21", "CCC12"]) {
      expect(get(next, t).rvol, t).not.toBe("");
      expect(get(next, t), t).toEqual(get(old, t));
    }
  });

  it("a ticker with a cliff does not touch another ticker in the same table", () => {
    const post: Bar[] = POST_CLOSES.map(() => ({ close: 2.8, volume: 8_000_000 }));
    const normal: Bar[] = Array.from({ length: 25 }, (_, i) => ({ close: (50 + (i % 3)).toFixed(4), volume: 2_000_000 + 10_000 * i }));
    const fixture = bars("MERCN", [...preSplit(15), ...post]) + bars("ZZZ25", normal);
    const next = readNew(fixture);
    expect(get(next, "MERCN").rvol).toBe("");
    expect(get(next, "ZZZ25")).toEqual(get(readOld(fixture), "ZZZ25"));
  });

  it("a last row with volume 0 or null is null (the average too), whatever the window; prev_close still comes through", () => {
    const prior = flat(20, 10, 1_000_000);
    const zero = get(readNew(bars("LAST0", [...prior, { close: 10.5, volume: 0 }])), "LAST0");
    expect(zero.avg).toBe("");
    expect(zero.rvol).toBe("");
    expect(zero.prevClose).toBe("10.0000");
    const none = get(readNew(bars("LASTN", [...prior, { close: 10.5, volume: null }])), "LASTN");
    expect(none.avg).toBe("");
    expect(none.rvol).toBe("");
  });

  it("short history: 9 prior rows is null, 10 prior real volumes is a value; a single row is null with no prev_close", () => {
    const nine = get(readNew(bars("SHORT9", [...flat(9, 10, 1_000_000), { close: 10, volume: 3_000_000 }])), "SHORT9");
    expect(nine.avg).toBe("");
    const ten = get(readNew(bars("SHORT10", [...flat(10, 10, 1_000_000), { close: 10, volume: 3_000_000 }])), "SHORT10");
    expect(ten.rvol).toBe("3.00");
    const one = get(readNew(bars("ONE", [{ close: 10, volume: 3_000_000 }])), "ONE");
    expect(one.avg).toBe("");
    expect(one.rvol).toBe("");
    expect(one.prevClose).toBe("");
  });

  it("the thresholds are exclusive: a step to exactly 0.75 or 1.35 of the previous close is not a break, just past it is", () => {
    const at = (last: string): Bar[] => [...flat(20, 100, 1_000_000), { close: last, volume: 2_000_000 }];
    const next = readNew(
      bars("T075", at("75.0000")) + bars("T0749", at("74.9900")) + bars("T135", at("135.0000")) + bars("T1351", at("135.0100")),
    );
    expect(get(next, "T075").rvol).toBe("2.00");
    expect(get(next, "T0749").rvol).toBe("");
    expect(get(next, "T135").rvol).toBe("2.00");
    expect(get(next, "T1351").rvol).toBe("");
  });

  it("a zero close in the window does not raise a division by zero (the divisor is tested first)", () => {
    const rows: Bar[] = [...flat(12, 10, 1_000_000), { close: 0, volume: 1_000_000 }, { close: 5, volume: 1_000_000 }, ...flat(8, 5, 1_000_000)];
    const r = get(readNew(bars("ZEROC", rows)), "ZEROC");
    // the drop to 0 is a break and it is in the window
    expect(r.rvol).toBe("");
  });

  it("returns one row per ticker with the production columns in order, types and options", () => {
    const cols = runPsql(
      `select a.attname || ':' || format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = 'public.bist_quote_stats'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum;`,
    )
      .split("\n")
      .filter(Boolean);
    expect(cols).toEqual(COLUMNS.map(([n, t]) => `${n}:${t}`));
    const fixture = bars("ONE1", flat(3, 10, 1)) + bars("TWO2", flat(25, 10, 1));
    expect(Object.keys(readNew(fixture)).sort()).toEqual(["ONE1", "TWO2"]);
  });

  it("keeps security_invoker on and production's ACL: service_role has every privilege, anon and authenticated none", () => {
    expect(runPsql(`select coalesce(reloptions::text, '') from pg_class where oid = 'public.bist_quote_stats'::regclass;`).trim()).toBe("{security_invoker=on}");
    const privs = runPsql(
      `select string_agg(grantee::regrole::text, ',' order by grantee::regrole::text) from (select distinct (aclexplode(relacl)).grantee from pg_class where oid = 'public.bist_quote_stats'::regclass) g where grantee <> 0;`,
    ).trim();
    expect(privs).toBe("postgres,service_role");
    expect(runPsql(`select has_table_privilege('anon', 'public.bist_quote_stats', 'select'), has_table_privilege('authenticated', 'public.bist_quote_stats', 'select');`).trim()).toBe("f|f");
    expect(runPsql(`select has_table_privilege('service_role', 'public.bist_quote_stats', 'select');`).trim()).toBe("t");
  });

  it("works in a read-only transaction (the pages read it through one)", () => {
    expect(runPsql(`begin read only;\nselect count(*) from public.bist_quote_stats;\nrollback;\n`).trim()).toBe("0");
  });

  it("a ticker filter reaches the bars' primary key (partition-by-ticker keeps the qual pushed down)", () => {
    const plan = runPsql(
      `begin;\nset local enable_seqscan = off;\nset local enable_bitmapscan = off;\nexplain select * from public.bist_quote_stats where ticker in ('MERCN', 'GARAN');\nrollback;\n`,
    );
    expect(plan).toContain("bist_bars_daily_pkey");
    expect(plan).toContain("Index Cond: (ticker = ANY");
  });

  it("is recorded in the ledger once", () => {
    expect(runPsql(`select count(*) from supabase_migrations.schema_migrations where version = '174' and name = '174_bist_quote_stats_unit_guard';`).trim()).toBe("1");
  });
});
