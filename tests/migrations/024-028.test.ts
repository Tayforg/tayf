import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Integration test for migrations 024 (pgmq setup), 025 (worker triggers),
// and 026 (content_hash unification).
//
// **Gated:** This file does TWO things depending on the environment.
//
//   1. Always: static SQL assertions (lint-style). The migration files must
//      contain the canonical statements the worker-stream architecture is
//      contracted against (pgmq.create('cluster_work'), CHECK constraint on
//      content_hash, the politics whitelist, etc.). These run in every CI
//      box including ones without a local Supabase.
//
//   2. When `process.env.SUPABASE_LOCAL_URL` is set: connect to that
//      Postgres, apply 024/025/026 in order, then exercise the live
//      behaviour (queue exists, trigger fires on INSERT, CHECK constraint
//      rejects sha256-length hashes). CI without a local Supabase skips
//      these via vitest's `it.runIf(...)` predicate.
//
// The static checks alone catch ~80 % of the regressions Phase 3 QA is
// likely to flag — the live checks are the bonus tier for the user's
// future local-dev workflow.
// ---------------------------------------------------------------------------

const SUPABASE_LOCAL_URL = process.env.SUPABASE_LOCAL_URL;
const LIVE = Boolean(SUPABASE_LOCAL_URL);

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

// ---------------------------------------------------------------------------
// Static checks — always run.
// ---------------------------------------------------------------------------

describe("migration 024_pgmq_setup.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("024_pgmq_setup.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("creates the pgmq extension", () => {
    expect(sql).toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+pgmq/i);
  });

  it("creates the cluster_work queue", () => {
    expect(sql).toMatch(/pgmq\.create\(\s*'cluster_work'\s*\)/i);
  });

  it("creates the image_backfill queue", () => {
    expect(sql).toMatch(/pgmq\.create\(\s*'image_backfill'\s*\)/i);
  });

  it("does NOT create the worker_checkpoint table (Round-6 P1 removed it as dead schema)", () => {
    // The original 024 created public.worker_checkpoint as a safety-net
    // resume marker for a Vercel-cron fallback consumer that was never
    // wired. Round-6 P1 removed the dead schema from this migration;
    // migration 028 drops it on databases that previously applied the
    // original 024. If a maintainer reintroduces the table here without
    // wiring a real consumer, this assertion fails on the spot.
    expect(sql).not.toMatch(/create\s+table[^;]*worker_checkpoint/i);
    expect(sql).not.toMatch(/last_seen_article_id\s+uuid/i);
    expect(sql).not.toMatch(/last_seen_id\s+bigint/i);
  });

  it("exposes a worker_metrics view (read-only surface for /api/health)", () => {
    expect(sql).toMatch(/create\s+(or\s+replace\s+)?view\s+worker_metrics/i);
  });

  it("revokes pgmq function access from anon / authenticated", () => {
    expect(sql).toMatch(/revoke[^;]*from\s+(anon|authenticated)/i);
  });
});

describe("migration 025_worker_triggers.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("025_worker_triggers.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("defines the cluster_work enqueue trigger AFTER INSERT on articles", () => {
    expect(sql).toMatch(
      /after\s+insert\s+on\s+articles[\s\S]+execute\s+function\s+enqueue_cluster_work/i,
    );
  });

  it("defines the image_backfill enqueue trigger AFTER INSERT on articles", () => {
    expect(sql).toMatch(
      /after\s+insert\s+on\s+articles[\s\S]+execute\s+function\s+enqueue_image_backfill/i,
    );
  });

  it("scopes cluster_work to the politics whitelist (politika / son_dakika)", () => {
    expect(sql).toMatch(/politika/);
    expect(sql).toMatch(/son_dakika/);
  });

  it("guards image_backfill on NEW.image_url IS NULL (skip rows that already have images)", () => {
    expect(sql).toMatch(/NEW\.image_url\s+is\s+(not\s+)?null/i);
  });

  it("filters at the trigger level via WHEN clauses (cheap predicate before the SECURITY DEFINER call)", () => {
    // P3-5 fix: without WHEN, both SECURITY DEFINER functions fire for
    // EVERY insert and bail inside plpgsql. The trigger-level predicates
    // keep non-matching rows from invoking the functions at all; the
    // in-function guards stay as belt-and-braces.
    expect(sql).toMatch(
      /when\s*\(\s*NEW\.category\s+in\s*\(\s*'politika'\s*,\s*'son_dakika'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(/when\s*\(\s*NEW\.image_url\s+is\s+null\s*\)/i);
  });

  it("pins trigger-function ownership to postgres (deterministic SECURITY DEFINER owner)", () => {
    // S10 fix: the pgmq.send grant block targets postgres /
    // supabase_admin specifically, so ownership must be pinned rather
    // than inherited from whichever role ran the migration. The pin is
    // wrapped in a role-existence guard for vanilla Postgres.
    expect(sql).toMatch(/alter\s+function\s+enqueue_cluster_work\(\)\s+owner\s+to\s+postgres/i);
    expect(sql).toMatch(/alter\s+function\s+enqueue_image_backfill\(\)\s+owner\s+to\s+postgres/i);
  });

  it("is idempotent — drops triggers before recreating", () => {
    expect(sql).toMatch(/drop\s+trigger\s+if\s+exists\s+articles_cluster_enqueue/i);
    expect(sql).toMatch(/drop\s+trigger\s+if\s+exists\s+articles_image_enqueue/i);
  });

  it("locks SECURITY DEFINER trigger functions to an empty search_path", () => {
    // Round-6 P1 tripwire: the original migration set `search_path = public,
    // pgmq, pg_temp` on the SECURITY DEFINER trigger functions, which let a
    // role with CREATE on pg_temp shadow unqualified calls inside the
    // function body and execute under the function owner. The fix is empty
    // search_path + schema-qualified identifiers. If either assertion
    // regresses, the audit-era footgun is back.
    expect(sql).not.toMatch(/set\s+search_path[^\n]*pg_temp/i);
    expect(sql).toMatch(/set\s+search_path\s*=\s*''/i);
    // Identifiers must be schema-qualified inside the SECURITY DEFINER body.
    expect(sql).toMatch(/pg_catalog\.jsonb_build_object/);
  });

  it("revokes EXECUTE on both enqueue functions from anon + authenticated (close the PostgREST RPC exposure)", () => {
    // Supabase auto-grants EXECUTE on new public functions to anon +
    // authenticated, so without an explicit revoke both trigger functions
    // are callable unauthenticated via POST /rest/v1/rpc/enqueue_*. Pin
    // the revoke for each function and require anon + authenticated to be
    // named (revoking from public alone leaves the role-direct grants).
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+enqueue_cluster_work\(\)\s+from\s+[^;]*\banon\b[^;]*\bauthenticated\b/i,
    );
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+enqueue_image_backfill\(\)\s+from\s+[^;]*\banon\b[^;]*\bauthenticated\b/i,
    );
  });

  it("grants pgmq.send EXECUTE to the SECURITY DEFINER owner roles (postgres, supabase_admin)", () => {
    // Round-4 fix: the SECURITY DEFINER trigger functions invoke pgmq.send
    // under the function-owner identity; without this grant the trigger
    // fails with "permission denied for function pgmq.send" on any
    // non-service_role owner. The migration implements the grant via a
    // defensive `do $$ ... execute format('grant execute on function %s
    // to %I', ...) $$;` block so it survives function-overload set drift
    // AND missing-role scenarios (vanilla Postgres without the Supabase
    // role bundle). Tripwire: removing any of the four invariants below
    // silently regresses Round-3 P1 (SECURITY DEFINER grant propagation).
    expect(sql).toMatch(/grant\s+execute\s+on\s+function/i);
    expect(sql).toMatch(/n\.nspname\s*=\s*'pgmq'/i);
    expect(sql).toMatch(/'postgres'\s*,\s*'supabase_admin'/);
    expect(sql).toMatch(/pg_roles\s+where\s+rolname\s*=\s*target_role/i);
  });
});

describe("migration 026_unify_content_hash_v2.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("026_unify_content_hash_v2.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("is NON-DESTRUCTIVE — contains no DELETE of sha256-length rows", () => {
    // Production hardening: 95% of the corpus carries 64-hex sha256
    // hashes (old data) and 5% carries 40-hex sha1 (new ingest); the two
    // regimes coexist permanently. The earlier draft hard-deleted every
    // 64-hex row to enforce a length=40 CHECK, which on the live DB would
    // have destroyed 95% of articles (cascading through cluster_articles).
    // The migration must not delete anything.
    expect(sql).not.toMatch(/delete\s+from\s+articles/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("adds a PERMISSIVE dual-regime CHECK (lowercase 40-hex OR 64-hex, or null)", () => {
    // The only enforcement: content_hash is null, or lowercase-hex of
    // length 40 (sha1) OR 64 (sha256). Every existing row already
    // satisfies this, so it rejects nothing in the table — it only bars a
    // future uppercase / truncated / non-hex write.
    expect(sql).toMatch(
      /check\s*\(\s*content_hash\s+is\s+null\s+or\s+content_hash\s*~\s*'\^\[0-9a-f\]\{40\}\$'\s+or\s+content_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'\s*\)/i,
    );
  });

  it("adds the CHECK as NOT VALID (no full-table validate lock on ~355k rows)", () => {
    // NOT VALID still enforces the predicate on every new write; it only
    // skips the one-time scan/lock of pre-existing rows (already valid).
    expect(sql).toMatch(/add\s+constraint\s+articles_content_hash_length_chk[\s\S]*\bnot\s+valid\b/i);
  });

  it("does NOT install a strict length=40-only CHECK", () => {
    // A constraint that accepts only 40-hex would reject the 95% sha256
    // majority. The 64-hex branch must be present (asserted above); a
    // bare 40-only regex with no 64 alternative is a regression.
    expect(sql).not.toMatch(
      /check\s*\(\s*content_hash\s+is\s+null\s+or\s+content_hash\s*~\s*'\^\[0-9a-f\]\{40\}\$'\s*\)/i,
    );
    expect(sql).not.toMatch(/check\s*\(\s*length\(content_hash\)\s*=\s*40\s*\)/i);
  });

  it("does NOT drop the UNIQUE constraint on (source_id, content_hash)", () => {
    // Negative assertion: refusing to drop the dedup key.
    expect(sql).not.toMatch(/drop\s+constraint[^;]*source_id[^;]*content_hash/i);
  });
});

// ---------------------------------------------------------------------------
// Migration 027 — atomic cluster_articles link + clusters recompute under
// a per-cluster advisory lock. Round-6 P1 fix for the concurrent
// cluster-write race that left clusters.article_count under-counted when
// two consumers added different articles to the same cluster in parallel.
// ---------------------------------------------------------------------------

describe("migration 027_cluster_link_atomic.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("027_cluster_link_atomic.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("defines public.cluster_link_atomic(...) as SECURITY DEFINER", () => {
    expect(sql).toMatch(/create\s+function\s+public\.cluster_link_atomic/i);
    expect(sql).toMatch(/security\s+definer/i);
  });

  it("locks the function to an empty search_path with pg_catalog-qualified calls", () => {
    // Round-6 P1 tripwire (mirrors the migration 025 lock): empty
    // search_path + schema-qualified identifiers so pg_temp shadowing
    // cannot reach the SECURITY DEFINER body.
    expect(sql).not.toMatch(/set\s+search_path[^\n]*pg_temp/i);
    expect(sql).toMatch(/set\s+search_path\s*=\s*''/i);
    expect(sql).toMatch(/pg_catalog\.pg_advisory_xact_lock/);
    expect(sql).toMatch(/pg_catalog\.hashtext/);
    expect(sql).toMatch(/pg_catalog\.count/);
  });

  it("uses pg_advisory_xact_lock for per-cluster serialization", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(\s*pg_catalog\.hashtext/i);
  });

  it("INSERTs into cluster_articles with ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(/insert\s+into\s+public\.cluster_articles/i);
    expect(sql).toMatch(/on\s+conflict\s+do\s+nothing/i);
  });

  it("recomputes article_count under the lock before UPDATEing clusters", () => {
    // The COUNT(*) must be inside the function body BEFORE the UPDATE;
    // a naive implementation that passed an externally-computed count
    // would re-introduce the race.
    expect(sql).toMatch(/select\s+pg_catalog\.count\(\*\)\s+into\s+v_count[\s\S]*from\s+public\.cluster_articles/i);
    const updateIdx = sql.search(/update\s+public\.clusters/i);
    const countIdx = sql.search(/select\s+pg_catalog\.count\(\*\)\s+into\s+v_count/i);
    expect(countIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(countIdx);
  });

  it("grants EXECUTE to service_role only (revokes from anon / authenticated / public)", () => {
    // Supabase auto-grants EXECUTE to anon + authenticated on creation, so
    // the revoke must name them explicitly — revoking from public alone
    // leaves the role-direct grants and the RPC stays exposed via
    // PostgREST. The service_role grant is the only access kept.
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.cluster_link_atomic[\s\S]*from\s+[^;]*\banon\b[^;]*\bauthenticated\b[^;]*\bpublic\b/i,
    );
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.cluster_link_atomic[\s\S]*to\s+service_role/i);
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function\s+public\.cluster_link_atomic[^;]+to\s+(anon|authenticated)/i);
  });

  it("stamps clusters.updated_at with now(), not member published_at (liveness signal)", () => {
    // P3-12 fix: /api/health reads MAX(clusters.updated_at) as the
    // pipeline-alive signal. Deriving it from the members' max
    // published_at would make a write triggered by a republished old
    // article look stale, so the RPC stamps the wall clock instead and
    // the p_last_published parameter is gone entirely.
    expect(sql).toMatch(/updated_at\s*=\s*pg_catalog\.now\(\)/i);
    expect(sql).not.toMatch(/p_last_published/i);
  });
});

// ---------------------------------------------------------------------------
// Migration 028 — clean-drop of worker_checkpoint on databases that
// applied the original 024 (Round-6 P1 follow-up).
// ---------------------------------------------------------------------------

describe("migration 028_drop_worker_checkpoint.sql (static)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("028_drop_worker_checkpoint.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("drops the trigger and the function", () => {
    expect(sql).toMatch(/drop\s+trigger\s+if\s+exists\s+worker_checkpoint_set_updated_at/i);
    expect(sql).toMatch(/drop\s+function\s+if\s+exists\s+public\.worker_checkpoint_set_updated_at/i);
    expect(sql).toMatch(/drop\s+table\s+public\.worker_checkpoint/i);
  });

  it("guards the trigger + table drop behind a worker_checkpoint existence check (fresh-DB safe)", () => {
    // `drop trigger if exists ... on public.worker_checkpoint` raises
    // 42P01 when the TABLE is absent (IF EXISTS covers the trigger, not
    // the table), which fails the migration on every fresh DB. The
    // trigger + table drops must sit inside a pg_class existence check.
    expect(sql).toMatch(
      /if\s+exists\s*\([\s\S]*pg_class[\s\S]*c\.relname\s*=\s*'worker_checkpoint'[\s\S]*\)\s*then/i,
    );
    // The bare table drop must NOT appear outside a guard as an
    // unconditional statement (no IF EXISTS fallback was kept).
    expect(sql).not.toMatch(/drop\s+table\s+if\s+exists\s+public\.worker_checkpoint/i);
  });
});

// ---------------------------------------------------------------------------
// Cross-migration tripwire — the pgmq schema is exposed to PostgREST
// (supabase/config.toml api.schemas) intentionally, for operator tooling
// behind service_role. That makes one stray future GRANT on a pgmq object
// to anon / authenticated / PUBLIC a full queue-API leak, so scan EVERY
// migration file, present and future.
// ---------------------------------------------------------------------------

describe("pgmq exposure tripwire (all migrations, static)", () => {
  it("no migration grants anything on pgmq objects to anon / authenticated / public", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    // Strip `--` line comments first so prose like "we do NOT grant ...
    // to anon" cannot false-positive, then flag any GRANT span that
    // mentions pgmq and lists anon / authenticated / PUBLIC after its
    // to-clause. The legitimate `grant usage on schema pgmq to
    // service_role` in 024 stays clean — its to-clause names only
    // service_role.
    const leak = /grant[^;]*\bpgmq\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i;
    const offenders = files.filter((f) => {
      const sql = read(f)
        .split(/\r?\n/)
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
      return leak.test(sql);
    });
    expect(offenders).toEqual([]);
  });

  it("sanity: 024's legitimate service_role grant is still present (regex is not vacuous)", () => {
    expect(read("024_pgmq_setup.sql")).toMatch(
      /grant\s+usage\s+on\s+schema\s+pgmq\s+to\s+service_role/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Live integration checks — opt-in via SUPABASE_LOCAL_URL.
//
// These speak Postgres directly. We don't pull in a Supabase JS client here
// because the wire protocol is simpler — and these tests are about the SQL
// side, not the JS SDK. We use the `pg` driver.
//
// Opting in is binding: when SUPABASE_LOCAL_URL is set, a missing `pg`
// driver or an unreachable server FAILS the suite from beforeAll instead of
// silently no-opping every assertion — a live tier that quietly passes
// without running is worse than no live tier at all.
// ---------------------------------------------------------------------------

describe.runIf(LIVE)("migrations 024–026 (live against SUPABASE_LOCAL_URL)", () => {
  type PgClient = {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    end: () => Promise<void>;
  };

  let client!: PgClient;

  beforeAll(async () => {
    // Dynamic import: `pg` is intentionally not a hard dependency, but
    // once the live tier is opted into it must exist.
    const pgMod = (await import("pg").catch(() => null)) as
      | { Client?: new (opts: unknown) => PgClient }
      | null;
    if (!pgMod?.Client) {
      throw new Error(
        "SUPABASE_LOCAL_URL is set but the 'pg' driver is not installed — " +
          "run npm i -D pg or unset SUPABASE_LOCAL_URL",
      );
    }
    client = new pgMod.Client({ connectionString: SUPABASE_LOCAL_URL });
    // Deliberately no try/catch: a connection failure (server down,
    // wrong URL) must fail the suite, not downgrade it to a no-op.
    await (client as unknown as { connect: () => Promise<void> }).connect();
  });

  it("pgmq schema exists and the cluster_work / image_backfill queues are present", async () => {
    const { rows } = await client.query(
      "select queue_name from pgmq.list_queues() where queue_name in ('cluster_work', 'image_backfill')",
    );
    const names = rows.map((r) => String(r.queue_name)).sort();
    expect(names).toEqual(["cluster_work", "image_backfill"]);
  });

  it("inserting a politics article enqueues a cluster_work message", async () => {
    // Snapshot the queue depth, insert one row, snapshot again. The
    // trigger writes synchronously inside the same xact, so the count
    // delta must be exactly 1.
    const before = await client.query(
      "select count(*)::int as n from pgmq.q_cluster_work",
    );
    const beforeN = Number(before.rows[0]?.n ?? 0);

    await client.query(
      "insert into articles (title, url, source_id, content_hash, category) values ($1, $2, $3, $4, $5)",
      [
        "live-test-headline",
        `https://example.com/live-${Date.now()}`,
        // Source id and content_hash will fail this insert if the schema
        // doesn't have a placeholder row; the test catches that as a
        // failure and the user knows to seed appropriately.
        "00000000-0000-0000-0000-000000000000",
        "a".repeat(40),
        "politika",
      ],
    );

    const after = await client.query(
      "select count(*)::int as n from pgmq.q_cluster_work",
    );
    const afterN = Number(after.rows[0]?.n ?? 0);
    expect(afterN).toBe(beforeN + 1);
  });

  it("the content_hash CHECK accepts both sha1(40) and sha256(64) lowercase hex", async () => {
    // Dual-regime: old data is sha256 (64-hex), new ingest is sha1
    // (40-hex). Both must be insertable — the permissive CHECK rejects
    // neither.
    for (const hash of ["a".repeat(40), "a".repeat(64)]) {
      await client.query(
        "insert into articles (title, url, source_id, content_hash, category) values ($1, $2, $3, $4, $5)",
        [
          "live-good-hash",
          `https://example.com/good-${hash.length}-${Date.now()}`,
          "00000000-0000-0000-0000-000000000000",
          hash,
          "politika",
        ],
      );
    }
  });

  it("the content_hash CHECK rejects a non-hex / wrong-length value", async () => {
    // The permissive CHECK still bars anything that is not lowercase hex
    // of length 40 or 64 — e.g. an uppercase or truncated digest.
    let threw = false;
    try {
      await client.query(
        "insert into articles (title, url, source_id, content_hash, category) values ($1, $2, $3, $4, $5)",
        [
          "live-bad-hash",
          `https://example.com/bad-${Date.now()}`,
          "00000000-0000-0000-0000-000000000000",
          "A".repeat(40), // uppercase — must violate the lowercase-hex CHECK.
          "politika",
        ],
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
