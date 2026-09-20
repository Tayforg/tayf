import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JEV_MONTHLY_TOKEN_CAP_DEFAULT,
  JEV_NEUTRAL_MODEL_ID,
  JEV_POLITICS_CATEGORIES,
  JEV_QUESTION_SET_VERSION,
  JEV_TASKS,
  JEV_USD_PER_TOKEN,
  questionRegistryHash,
  type JevRunStatus,
  type JevSubjectType,
} from "../../supabase/functions/_shared/jev.ts";
import { EXTRACTIVE_MODEL_ID } from "@/lib/clusters/neutral-title";

// ---------------------------------------------------------------------------
// Static parity test for migration 061 (TypeSafe Jev shadow mode) and 063
// ("Jev şimdi"). Both migrations are additive-only and copied verbatim from
// the planner's SQL (see W1.md), so this file does not re-derive or lint the
// SQL the way 024-028.test.ts does -- it only pins the vocabularies that
// live in BOTH the migrations' comments/CHECK constraints and _shared/jev.ts's
// exported constants/types, so the files can never drift silently.
//
// CONSTANT DRIFT note (pack.md "Known risks"): JEV_POLITICS_CATEGORIES here
// duplicates POLITICS_CATEGORIES at cluster-consumer/index.ts:93 on purpose
// (importing the real one would drag Deno.serve into vitest). This test
// pins the literal against the migration comment; it cannot detect that
// cluster-consumer changed its own list independently -- same class of gap
// the guide calls out for stale deploys elsewhere in this repo.
//
// Cross-worker guards (063, pack.md "Risks to design against"): JEV-A17
// greps W2's supabase/functions/jev-shadow/index.ts and JEV-A19 greps W3's
// src/lib/admin/jev-gold.ts. Both are EXPECTED RED until those workers land
// in this same worktree -- do not weaken them, do not stub the files they
// read.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const FUNCTIONS_DIR = resolve(__dirname, "..", "..", "supabase", "functions");

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

describe("migration 061_jev_shadow.sql (static parity)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("061_jev_shadow.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("mentions every JEV_TASKS name in the task-column comments (061 + 063 concatenated)", () => {
    const combined = sql + read("063_jev_now_package.sql");
    for (const task of JEV_TASKS) {
      expect(combined).toContain(task);
    }
  });

  it("the subject_type CHECK list equals the JevSubjectType union members", () => {
    const match = sql.match(/subject_type\s+in\s*\(([^)]+)\)/i);
    expect(match).not.toBeNull();
    const values = (match![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);

    const expected: JevSubjectType[] = ["article", "pair", "cluster", "kap", "title_version"];
    expect(values.sort()).toEqual([...expected].sort());
  });

  it("the jev_shadow_runs status CHECK list equals the JevRunStatus union members", () => {
    const match = sql.match(/status\s+in\s*\(([^)]+)\)/i);
    expect(match).not.toBeNull();
    const values = (match![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);

    const expected: JevRunStatus[] = ["running", "ok", "partial", "rate_limited", "budget_exceeded", "error"];
    expect(values.sort()).toEqual([...expected].sort());
  });

  it("JEV_POLITICS_CATEGORIES deep-equals ['politika','son_dakika'], pinned against the cluster-consumer:93 pointer", () => {
    expect(JEV_POLITICS_CATEGORIES).toEqual(["politika", "son_dakika"]);
    // The migration's own comment documents which table/column this backs;
    // the cluster-consumer:93 cross-reference lives in _shared/jev.ts's
    // JSDoc (see the CONSTANT DRIFT note above), not in the SQL file, so we
    // assert the constant value here rather than grepping the migration for
    // a line number that would immediately go stale.
    expect(JEV_POLITICS_CATEGORIES).toHaveLength(2);
  });

  it("contains the ledger insert for '061'", () => {
    expect(sql).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations[\s\S]*?values\s*\(\s*'061'\s*,\s*'061_jev_shadow'\s*\)/i,
    );
  });

  it("is additive-only: creates tables/functions with IF NOT EXISTS / OR REPLACE, never DROP or ALTER an existing object", () => {
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+column\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.(articles|clusters)\b/i);
  });

  it("is service_role-only: RLS enabled and anon/authenticated/public explicitly revoked on all three new tables", () => {
    for (const table of ["jev_shadow_runs", "jev_shadow_predictions", "jev_shadow_reviews"]) {
      expect(sql).toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"));
      expect(sql).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"));
    }
  });
});

// ---------------------------------------------------------------------------
// JEV-A1 static guard: every column jev-shadow/index.ts's
// fetchPendingTitleVersions passes to `.gte()`/`.order()` against
// `article_title_versions` must be a real column in migration 056's DDL.
// This is the coverage fix for the `created_at` vs `seen_at` bug -- neither
// tsc (tsconfig.json excludes supabase/functions/**) nor
// tests/functions/jev-shadow.test.ts (scoped to _shared only) can catch a
// PostgREST column-name mismatch, since JevPorts is an interface with no
// knowledge of the underlying schema.
// ---------------------------------------------------------------------------

describe("jev-shadow/index.ts <-> article_title_versions column parity (JEV-A1)", () => {
  it("every .gte()/.order() column used against article_title_versions exists in migration 056's DDL", () => {
    const indexTs = readFileSync(resolve(FUNCTIONS_DIR, "jev-shadow", "index.ts"), "utf8");
    const migration056 = read("056_article_title_versions.sql");
    const columns = ddlColumns(migration056, "article_title_versions");
    expect(columns.length).toBeGreaterThan(0);

    const fnMatch = indexTs.match(/async fetchPendingTitleVersions[\s\S]*?\n    \},\n/);
    expect(fnMatch, "could not find fetchPendingTitleVersions in jev-shadow/index.ts").not.toBeNull();
    const fnBody = fnMatch![0];

    const usedColumns = new Set<string>();
    for (const m of fnBody.matchAll(/\.(?:gte|lte|gt|lt|eq|order)\(\s*"([a-z_]+)"/g)) {
      usedColumns.add(m[1]!);
    }
    expect(usedColumns.size).toBeGreaterThan(0);
    for (const col of usedColumns) {
      expect(
        columns,
        `column "${col}" used in fetchPendingTitleVersions is not a real article_title_versions column (migration 056)`,
      ).toContain(col);
    }
    // The bug this guard exists for: `created_at` does not exist on this table.
    expect(usedColumns.has("created_at")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JEV-A16: the monthly token cap default and the USD/token conversion rate
// are hand-duplicated in three places (063's SQL default, _shared/jev.ts,
// and src/lib/admin/jev-shadow-status.ts's "keep in sync by hand" literal).
// Pin both so a change to one drifts loudly instead of silently.
//
// 063 raises the cap 3e8 -> 5e8; 061's own file is NOT edited (063 is
// additive-only, CREATE OR REPLACE with an unchanged signature) so 061's
// literal stays the superseded 3e8 forever -- the live default now lives in
// 063 alone.
// ---------------------------------------------------------------------------

describe("jev-shadow cost constants: cap + USD/token parity (JEV-A16)", () => {
  it("063's jev_shadow_month_usage default cap matches JEV_MONTHLY_TOKEN_CAP_DEFAULT", () => {
    expect(read("063_jev_now_package.sql")).toContain(`p_cap bigint default ${JEV_MONTHLY_TOKEN_CAP_DEFAULT}`);
  });

  it("063's jev_gold_scorecard feed_politics CTE matches JEV_POLITICS_CATEGORIES (M4)", () => {
    expect(read("063_jev_now_package.sql")).toContain(
      `a.category in (${JEV_POLITICS_CATEGORIES.map((c) => `'${c}'`).join(", ")})`,
    );
  });

  it("061 keeps its historical 300000000 literal — superseded by 063, not edited", () => {
    expect(read("061_jev_shadow.sql")).toContain("p_cap bigint default 300000000");
  });

  it("JEV_USD_PER_TOKEN in src/lib/admin/jev-shadow-status.ts equals the one in _shared/jev.ts", () => {
    const adminPath = resolve(__dirname, "..", "..", "src", "lib", "admin", "jev-shadow-status.ts");
    const adminSrc = readFileSync(adminPath, "utf8");
    const match = adminSrc.match(/const\s+JEV_USD_PER_TOKEN\s*=\s*([\d_]+)\s*\/\s*([\d_]+)\s*;/);
    expect(match, "could not find JEV_USD_PER_TOKEN literal in jev-shadow-status.ts").not.toBeNull();
    const numerator = Number(match![1]!.replace(/_/g, ""));
    const denominator = Number(match![2]!.replace(/_/g, ""));
    expect(numerator / denominator).toBe(JEV_USD_PER_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// migration 063_jev_now_package.sql (static parity) -- the "Jev şimdi"
// package: jev_gold_set / jev_gold_labels, the three gold functions, and the
// jev-cluster-audit cron.
// ---------------------------------------------------------------------------

describe("migration 063_jev_now_package.sql (static parity)", () => {
  let sql063 = "";
  beforeAll(() => {
    sql063 = read("063_jev_now_package.sql");
    expect(sql063.length).toBeGreaterThan(0);
  });

  it("contains the ledger insert for '063'", () => {
    expect(sql063).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations[\s\S]*?values\s*\(\s*'063'\s*,\s*'063_jev_now_package'\s*\)/i,
    );
  });

  it("is additive-only: no DROP TABLE/COLUMN and no ALTER TABLE on articles/clusters/jev_shadow_predictions", () => {
    expect(sql063).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql063).not.toMatch(/\bdrop\s+column\b/i);
    expect(sql063).not.toMatch(/\balter\s+table\s+public\.(articles|clusters|jev_shadow_predictions)\b/i);
  });

  it("jev_gold_set and jev_gold_labels are service_role-only: RLS on, anon/authenticated/public revoked, sequence revoked", () => {
    for (const table of ["jev_gold_set", "jev_gold_labels"]) {
      expect(sql063).toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"));
      expect(sql063).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"),
      );
    }
    expect(sql063).toMatch(
      /revoke\s+all\s+on\s+sequence\s+public\.jev_gold_labels_id_seq\s+from\s+anon,\s*authenticated,\s*public/i,
    );
  });

  it("the jev_gold_labels topic CHECK list equals the seven feed topics", () => {
    const match = sql063.match(/topic\s+text\s+not\s+null\s+check\s*\(\s*topic\s+in\s*\(([^)]+)\)/i);
    expect(match, "could not find the jev_gold_labels.topic CHECK list").not.toBeNull();
    const values = (match![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
    expect(values).toEqual(["politika", "dunya", "ekonomi", "spor", "yasam", "teknoloji", "genel"]);
  });

  it("the three gold functions are SECURITY DEFINER with search_path = '' and revoked from anon/authenticated/public", () => {
    for (const fn of ["jev_gold_seed", "jev_gold_next", "jev_gold_scorecard"]) {
      const fnMatch = sql063.match(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\([^)]*\\)[\\s\\S]*?\\$fn\\$;`, "i"),
      );
      expect(fnMatch, `could not find function public.${fn}`).not.toBeNull();
      const body = fnMatch![0];
      expect(body).toMatch(/security\s+definer/i);
      expect(body).toMatch(/set\s+search_path\s*=\s*''/i);
    }
    for (const fnSig of ["jev_gold_seed\\(int\\)", "jev_gold_next\\(smallint\\)", "jev_gold_scorecard\\(\\)"]) {
      expect(sql063).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fnSig}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"),
      );
    }
  });

  it('schedules jev-cluster-audit at \'55 3 * * *\' posting {"mode":"audit"}', () => {
    expect(sql063).toMatch(/cron\.schedule\(\s*'jev-cluster-audit'\s*,\s*'55 3 \* \* \*'/);
    expect(sql063).toContain('{"mode":"audit"}');
  });

  // DB-1: jev_gold_scorecard's gold CTE must map the human 'dunya' topic to
  // NULL (ambiguous, excluded from jev_topic's n), mirroring topicBaseline()
  // in supabase/functions/_shared/jev.ts, which also returns null for
  // dunya -- NOT to 'other', which would silently score a correct 'politics'
  // answer on a world-politics story as wrong. This guard is the authorized
  // exception to byte-identical acceptance: it pins the one deviation from
  // the planner's literal SQL, so the taxonomy parity can never regress back
  // to the else-only mapping without failing here first.
  it("gold CTE maps human topic 'dunya' to null (ambiguous) and topic_rows excludes it from jev_topic's n (DB-1)", () => {
    expect(sql063).toMatch(/when\s+b\.topic1\s*=\s*'dunya'\s+then\s+null/);
    expect(sql063).toContain("and g.topic3 is not null");
  });
});

// ---------------------------------------------------------------------------
// JEV-A20: JEV_QUESTION_SET_VERSION and questionRegistryHash() are bumped
// together, or not at all -- a wording change that forgets to bump either
// fails here rather than silently mixing pre/post-change predictions under
// the same question_set stamp.
// ---------------------------------------------------------------------------

describe("question set version + registry hash (JEV-A20)", () => {
  it("pins JEV_QUESTION_SET_VERSION and questionRegistryHash together — bump BOTH or neither", async () => {
    expect(JEV_QUESTION_SET_VERSION).toBe("2026-09-21.1");
    expect(await questionRegistryHash()).toBe("e554d7cbee345a0ad2be2e9a59f659694718044af53b04a9e1cb460898a20d00");
  });
});

// ---------------------------------------------------------------------------
// JEV-A17 static guard (EXPECTED RED until W2 lands supabase/functions/
// jev-shadow/index.ts's fetchPendingTickerMatches -- see pack.md "Risks to
// design against" and W1.md's instructions. Do not weaken, do not stub.
// ---------------------------------------------------------------------------

describe("jev-shadow/index.ts <-> article_tickers query shape (JEV-A17)", () => {
  it('fetchPendingTickerMatches queries .from("article_tickers") and orders by its own published_at', () => {
    const indexTs = readFileSync(resolve(FUNCTIONS_DIR, "jev-shadow", "index.ts"), "utf8");
    const fnMatch = indexTs.match(/async fetchPendingTickerMatches[\s\S]*?\n    \},\n/);
    expect(fnMatch, "could not find fetchPendingTickerMatches in jev-shadow/index.ts").not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/\.from\(\s*"article_tickers"\s*\)/);
    expect(fnBody).toMatch(/\.order\(\s*"published_at"/);
    // Scoped to an actual .select(...) call, not prose -- a comment
    // explaining why the mirror-image `articles` + `article_tickers!inner`
    // embed is the wrong shape (the JEV-A3/DB-02 precedent) legitimately
    // contains this substring as documentation.
    expect(fnBody).not.toMatch(/\.select\([^)]*article_tickers!inner/);
  });

  it("reads bist_companies once per run, never once per ticker", () => {
    const indexTs = readFileSync(resolve(FUNCTIONS_DIR, "jev-shadow", "index.ts"), "utf8");
    const occurrences = (indexTs.match(/\.from\(\s*"bist_companies"\s*\)/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// JEV-A19 static guard (EXPECTED RED until W3 lands
// src/lib/admin/jev-gold.ts -- see pack.md "Risks to design against" and
// W1.md's instructions. Do not weaken, do not stub.
// ---------------------------------------------------------------------------

describe("gold topic vocabulary (JEV-A19)", () => {
  it("src/lib/admin/jev-gold.ts's JEV_GOLD_TOPICS equals migration 063's CHECK list", () => {
    const goldPath = resolve(__dirname, "..", "..", "src", "lib", "admin", "jev-gold.ts");
    const goldSrc = readFileSync(goldPath, "utf8");
    const match = goldSrc.match(/JEV_GOLD_TOPICS\s*=\s*\[([^\]]*)\]/);
    expect(match, "could not find JEV_GOLD_TOPICS literal in src/lib/admin/jev-gold.ts").not.toBeNull();
    const values = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect(values).toEqual(["politika", "dunya", "ekonomi", "spor", "yasam", "teknoloji", "genel"]);
  });
});

// ---------------------------------------------------------------------------
// M3: JEV_NEUTRAL_MODEL_ID (supabase/functions/_shared/jev.ts) must equal
// EXTRACTIVE_MODEL_ID (src/lib/clusters/neutral-title.ts) -- runJevShadow
// gates the entire neutral_pick stage on that equality, so a versioning
// drift between the two hand-duplicated constants would silently zero out
// the stage with no error and no log line.
// ---------------------------------------------------------------------------

describe("neutral model id parity (M3)", () => {
  it("JEV_NEUTRAL_MODEL_ID equals EXTRACTIVE_MODEL_ID", () => {
    expect(JEV_NEUTRAL_MODEL_ID).toBe(EXTRACTIVE_MODEL_ID);
  });
});

// ---------------------------------------------------------------------------
// JEV-A21 static guard (SEC-JEV-02): W2's HTTP envelope in
// supabase/functions/jev-shadow/index.ts has two acceptance criteria that
// hold by inspection only -- nothing in the vitest suite exercises the Edge
// Function's Deno.serve handler (it is not unit-testable from vitest), and
// the parity suite otherwise only greps individual helper functions
// (fetchPendingTickerMatches, bist_companies -- JEV-A17). Without this guard
// a refactor could silently move the JEV_DISABLED kill switch below a DB
// read / service-role client construction, or loosen the {"mode":"audit"}
// body-shape check, and ship green.
// ---------------------------------------------------------------------------

describe("jev-shadow/index.ts HTTP envelope ordering + kill switch (JEV-A21)", () => {
  it("requireServiceRoleBearer runs before JEV_DISABLED, which runs before AI_GATEWAY_API_KEY, which runs before makePorts()", () => {
    const indexTs = readFileSync(resolve(FUNCTIONS_DIR, "jev-shadow", "index.ts"), "utf8");
    // Literal call/read sites, not bare identifiers -- bare "AI_GATEWAY_API_KEY"
    // and "makePorts(" also occur earlier as prose (a comment explaining the
    // kill switch's placement relative to it) and as the function's own
    // declaration respectively, both of which would falsely satisfy an
    // ordering check against the bare identifier.
    const iBearer = indexTs.indexOf("requireServiceRoleBearer(req)");
    const iDisabled = indexTs.indexOf('Deno.env.get("JEV_DISABLED")');
    const iApiKey = indexTs.indexOf('Deno.env.get("AI_GATEWAY_API_KEY")');
    const iMakePorts = indexTs.indexOf("makePorts(apiKey)");
    for (const [label, idx] of [
      ["requireServiceRoleBearer(req)", iBearer],
      ['Deno.env.get("JEV_DISABLED")', iDisabled],
      ['Deno.env.get("AI_GATEWAY_API_KEY")', iApiKey],
      ["makePorts(apiKey)", iMakePorts],
    ] as const) {
      expect(idx, `could not find "${label}" in jev-shadow/index.ts`).toBeGreaterThan(-1);
    }
    expect(iBearer).toBeLessThan(iDisabled);
    expect(iDisabled).toBeLessThan(iApiKey);
    expect(iApiKey).toBeLessThan(iMakePorts);
  });

  it('the disabled response is exactly { ok: true, skipped: true, reason: "disabled" }', () => {
    const indexTs = readFileSync(resolve(FUNCTIONS_DIR, "jev-shadow", "index.ts"), "utf8");
    expect(indexTs).toContain('jsonResponse({ ok: true, skipped: true, reason: "disabled" })');
  });

  it('mode is derived as `mode === "audit" ? "audit" : "shadow"`, so any non-object body still 400s upstream as bad-json', () => {
    const indexTs = readFileSync(resolve(FUNCTIONS_DIR, "jev-shadow", "index.ts"), "utf8");
    expect(indexTs).toContain('=== "audit" ? "audit" : "shadow"');
    expect(indexTs).toMatch(/typeof\s+parsed\s*!==\s*"object"\s*\|\|\s*parsed\s*===\s*null\s*\|\|\s*Array\.isArray\(parsed\)/);
  });
});
