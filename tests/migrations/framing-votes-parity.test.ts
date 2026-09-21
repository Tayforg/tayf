import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static parity test for migration 068 (PACK D — "Oyun 2 + Çerçeveleme
// makbuzu"). Like tests/migrations/jev-shadow-parity.test.ts, this suite
// touches no database: 068_framing_votes.sql is copied verbatim from the
// planner's migration_sql (see W1.md STEP 1), so the tests below pin the
// vocabulary the SQL already commits to rather than re-deriving or linting
// it. This file does not import from _shared/jev.ts or from any other
// worker's test file -- its `read()` and `ddlColumns()` helpers are copied
// locally, on purpose, the same way jev-shadow-parity.test.ts does not share
// helpers across test files.
//
// CONTRACT CHANGE (orchestrator, pack.md "Orchestrator overrides"):
// framing_vote_totals' SQL RETURNS TABLE column is `neutral_n`, not `none`
// -- `none` is a reserved word and cannot be an unquoted output column name.
// src/lib/game/framing.ts (W2) maps SQL `neutral_n` -> JSON key `none`. The
// test name below keeps the brief's literal wording ("... none)") because
// that names the JSON/contract shape; its assertion checks the real SQL
// column, `neutral_n`.
//
// Cross-worker guards (PACKD-A1, PACKD-A2, PACKD-A3, pack.md "Acceptance
// criteria" + W1.md's instructions): these read W2's and W3's files with
// readFileSync and are EXPECTED RED until those workers land in this same
// worktree. Do not weaken them, do not stub the files they read, do not
// wrap them in try/catch -- a missing file must fail loudly.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const ROOT_DIR = resolve(__dirname, "..", "..");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

/** Column names declared inside a `create table ... ( ... )` block for one table. */
function ddlColumns(sql: string, table: string): string[] {
  const tableMatch = sql.match(
    new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  expect(tableMatch, `could not find CREATE TABLE for ${table}`).not.toBeNull();
  const body = tableMatch![1] ?? "";
  const columns: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) continue;
    const nameMatch = line.match(/^([a-z_][a-z0-9_]*)\s+/i);
    if (nameMatch && nameMatch[1] !== "unique" && nameMatch[1] !== "primary" && nameMatch[1] !== "check" && nameMatch[1] !== "foreign") {
      columns.push(nameMatch[1]!);
    }
  }
  return columns;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extracts one `create or replace function public.<name>(...) ... $fn$;` block. */
function functionBlock(sql: string, name: string): string {
  const match = sql.match(
    new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$;`, "i"),
  );
  expect(match, `could not find function public.${name} in the migration`).not.toBeNull();
  return match![0];
}

/** Column names declared inside a function's `returns table ( ... )` clause. */
function returnsTableColumns(block: string): string[] {
  const match = block.match(/returns\s+table\s*\(([\s\S]*?)\)\s*\nlanguage/i);
  expect(match, "could not find RETURNS TABLE clause").not.toBeNull();
  const body = match![1] ?? "";
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/,$/, ""))
    .map((line) => line.split(/\s+/)[0]!)
    .filter(Boolean);
}

const NEW_FUNCTIONS: Array<{ name: string; signature: string }> = [
  { name: "framing_vote_totals", signature: "framing_vote_totals(uuid)" },
  { name: "framing_next_headline", signature: "framing_next_headline(text)" },
  { name: "framing_gold_candidates", signature: "framing_gold_candidates(integer, numeric)" },
  { name: "cluster_framing_receipt", signature: "cluster_framing_receipt(uuid)" },
];

describe("migration 068_framing_votes.sql (static parity)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("068_framing_votes.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("contains the ledger insert for '068'", () => {
    expect(sql).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations[\s\S]*?values\s*\(\s*'068'\s*,\s*'068_framing_votes'\s*\)/i,
    );
    expect(sql).toMatch(/on\s+conflict\s+do\s+nothing/i);
    // "inside the same transaction" (pack.md acceptance) -- prove ordering,
    // not just presence: begin; ... insert ... ; commit;
    const beginIdx = sql.search(/\bbegin;/i);
    const insertIdx = sql.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    const commitIdx = sql.search(/\bcommit;/i);
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(insertIdx);
  });

  it("creates public.framing_votes with exactly (id, article_id, vote, session_hash, created_at) and no other column (PII guard)", () => {
    expect(ddlColumns(sql, "framing_votes")).toEqual(["id", "article_id", "vote", "session_hash", "created_at"]);
  });

  it("the vote CHECK list equals ['iktidar','muhalefet','none'] and there is a unique (article_id, session_hash)", () => {
    const match = sql.match(/vote\s+in\s*\(([^)]+)\)/i);
    expect(match).not.toBeNull();
    const values = (match![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
    expect(values.sort()).toEqual(["iktidar", "muhalefet", "none"].sort());
    expect(sql).toMatch(/unique\s*\(\s*article_id\s*,\s*session_hash\s*\)/i);
  });

  it("is additive-only: no DROP TABLE/COLUMN and no ALTER TABLE on articles/clusters/jev_shadow_predictions", () => {
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+column\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.(articles|clusters|jev_shadow_predictions)\b/i);
  });

  it("framing_votes is service_role-only: RLS on, anon/authenticated/public revoked, sequence revoked", () => {
    expect(sql).toMatch(/alter\s+table\s+public\.framing_votes\s+enable\s+row\s+level\s+security/i);
    expect(sql).not.toMatch(/create\s+policy[\s\S]*?on\s+public\.framing_votes/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+public\.framing_votes\s+from\s+anon,\s*authenticated,\s*public/i);
    expect(sql).toMatch(/grant\s+select,\s*insert\s+on\s+public\.framing_votes\s+to\s+service_role/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+sequence\s+public\.framing_votes_id_seq\s+from\s+anon,\s*authenticated,\s*public/i);
    expect(sql).toMatch(/grant\s+usage,\s*select\s+on\s+sequence\s+public\.framing_votes_id_seq\s+to\s+service_role/i);
  });

  it("the four new functions are SECURITY DEFINER with search_path = '' and revoked from anon/authenticated/public", () => {
    for (const fn of NEW_FUNCTIONS) {
      const block = functionBlock(sql, fn.name);
      expect(block, `${fn.name} missing security definer`).toMatch(/security\s+definer/i);
      expect(block, `${fn.name} missing search_path`).toMatch(/set\s+search_path\s*=\s*''/);
      const sig = escapeRegExp(fn.signature);
      expect(sql, `${fn.name} missing anon/authenticated/public revoke`).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${sig}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"),
      );
      expect(sql, `${fn.name} missing service_role grant`).toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${sig}\\s+to\\s+service_role`, "i"),
      );
    }
  });

  it("framing_vote_totals returns exactly (n, iktidar, muhalefet, none)", () => {
    const block = functionBlock(sql, "framing_vote_totals");
    // See the CONTRACT CHANGE header note: the SQL column is neutral_n, the
    // JSON key it maps to (in src/lib/game/framing.ts, W2) is `none`.
    expect(returnsTableColumns(block)).toEqual(["n", "iktidar", "muhalefet", "neutral_n"]);
  });

  it("framing_next_headline filters on task='politics' with jev_prob >= 0.7 inside a 48 hour window", () => {
    const block = functionBlock(sql, "framing_next_headline");
    expect(block).toMatch(/p\.task\s*=\s*'politics'/i);
    expect(block).toMatch(/p\.jev_prob\s*>=\s*0\.7\b/);
    expect(block).toMatch(/a\.published_at\s*>=\s*now\(\)\s*-\s*interval\s*'48 hours'/i);
  });

  it("framing_next_headline excludes the session's own votes and prefers headlines with fewer than 5 votes", () => {
    const block = functionBlock(sql, "framing_next_headline");
    expect(block).toMatch(
      /not\s+exists\s*\(\s*select\s+1\s*from\s+public\.framing_votes\s+v\s*where\s+v\.article_id\s*=\s*a\.id\s*and\s+v\.session_hash\s*=\s*p_session_hash/i,
    );
    expect(block).toMatch(/order\s+by\s*\(\s*t\.vote_count\s*>=\s*5\s*\)\s*asc,\s*random\(\)/i);
  });

  it("cluster_framing_receipt reads jev_answer->'answer'->'probabilities' behind a jsonb_typeof CASE guard and gates at 0.75", () => {
    const block = functionBlock(sql, "cluster_framing_receipt");
    expect(block).toMatch(
      /case\s+when\s+jsonb_typeof\(p\.jev_answer\s*->\s*'answer'\s*->\s*'probabilities'\s*->\s*p\.jev_choice\)\s*=\s*'number'\s+then\s+\(p\.jev_answer\s*->\s*'answer'\s*->\s*'probabilities'\s*->\s*p\.jev_choice\)::numeric\s+end,\s*0\s*\)\s*>=\s*0\.75/i,
    );
  });

  it("framing_gold_candidates defaults are p_min_votes integer default 5 and p_min_share numeric default 0.8", () => {
    const block = functionBlock(sql, "framing_gold_candidates");
    expect(block).toMatch(/p_min_votes\s+integer\s+default\s+5/i);
    expect(block).toMatch(/p_min_share\s+numeric\s+default\s+0\.8/i);
  });

  it("schedules no cron job and touches no Vault secret (pack D adds zero scheduled work)", () => {
    expect(sql).not.toMatch(/cron\.schedule/i);
    expect(sql).not.toMatch(/vault\.decrypted_secrets/i);
  });
});

// ---------------------------------------------------------------------------
// PACKD-A1..A3 cross-worker static guards (pack.md "Acceptance criteria",
// W1.md STEP 2). EXPECTED RED until W2 lands src/app/api/oyun/cerceve/** and
// W3 lands src/components/story/framing-receipt.tsx +
// src/lib/clusters/framing-receipt.ts in this same worktree. Do not weaken,
// do not stub, do not catch the ENOENT a missing file throws here.
// ---------------------------------------------------------------------------

describe("cross-worker guards (PACKD-A1..A3)", () => {
  it("PACKD-A1 (cross-worker): GET /api/oyun/cerceve/next imports isGameEligibleTitle from the shared PII filter", () => {
    const routeTs = readFileSync(resolve(ROOT_DIR, "src", "app", "api", "oyun", "cerceve", "next", "route.ts"), "utf8");
    expect(routeTs).toMatch(/from\s+"@\/lib\/game\/pii-filter"/);
    expect(routeTs).toContain("isGameEligibleTitle(");
  });

  it("PACKD-A2 (cross-worker): POST /api/oyun/cerceve never reads jev_shadow_predictions or imports the receipt lib", () => {
    const routeTs = readFileSync(resolve(ROOT_DIR, "src", "app", "api", "oyun", "cerceve", "route.ts"), "utf8");
    expect(routeTs).not.toMatch(/jev_shadow_predictions/);
    expect(routeTs).not.toMatch(/framing-receipt/);
    expect(routeTs).not.toMatch(/pro_government/);
  });

  it("PACKD-A3 (cross-worker): the receipt component carries the 0,75 threshold copy and the 'yargı değil' caveat", () => {
    const componentTsx = readFileSync(resolve(ROOT_DIR, "src", "components", "story", "framing-receipt.tsx"), "utf8");
    expect(componentTsx).toContain("framingReceiptSentence(");
    expect(componentTsx).toContain("FRAMING_RECEIPT_CAVEAT");
    const libTs = readFileSync(resolve(ROOT_DIR, "src", "lib", "clusters", "framing-receipt.ts"), "utf8");
    expect(libTs).toContain("eşik 0,75");
    expect(libTs).toContain("FRAMING_RECEIPT_PUBLIC");
  });
});
