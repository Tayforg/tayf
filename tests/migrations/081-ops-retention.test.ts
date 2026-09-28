import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 081 ("ops-retention": daily Jev
// rollup + ops-exhaust retention).
//
// jev_shadow_predictions (411 MB+, ~50 MB/day, nothing prunes it) is
// DELIBERATELY untouched here -- 081 only (a) rolls it up into a small daily
// summary table so /admin's 7-day agreement read stops scanning the raw
// table, and (b) prunes SYSTEM exhaust (cron.job_run_details,
// net._http_response), never a product table. The product-safety contract
// below is the load-bearing half of this file: nothing in 081 may delete,
// truncate or update jev_shadow_predictions or any other public table.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "081_ops_retention.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The `create or replace function public.<name>(...) ... $fn$ ... $fn$;` block. */
function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
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

/** Only the SQL body between the $fn$ quotes. */
function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

describe("migration 081_ops_retention.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
  });

  it("contains the ledger insert for '081' and is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'081'\s*,\s*'081_ops_retention'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  // -------------------------------------------------------------------------
  // Product-safety contract -- the whole reason this file exists.
  // -------------------------------------------------------------------------

  it("every DELETE target is one of the two system-exhaust tables, never a product table", () => {
    const deleteTargets = [...code.matchAll(/delete\s+from\s+([a-z_][\w.]*)/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(deleteTargets.length).toBeGreaterThan(0);
    for (const target of deleteTargets) {
      expect(["cron.job_run_details", "net._http_response"]).toContain(target);
    }
  });

  it("never truncates, drops, or vacuums anything", () => {
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\bvacuum\b/i);
  });

  it("never deletes, truncates or updates jev_shadow_predictions", () => {
    expect(code).not.toMatch(/(delete\s+from|update|truncate(\s+table)?)\s+public\.jev_shadow_predictions/i);
  });

  it("never updates or deletes any public. table", () => {
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).not.toMatch(/\bdelete\s+from\s+public\./i);
  });

  it("the only INSERTs are into jev_shadow_daily and the ledger", () => {
    const insertTargets = [...code.matchAll(/insert\s+into\s+([a-z_][\w.]*)/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(insertTargets.length).toBeGreaterThan(0);
    for (const target of insertTargets) {
      expect(["public.jev_shadow_daily", "supabase_migrations.schema_migrations"]).toContain(
        target,
      );
    }
  });

  it("jev_shadow_predictions is only ever referenced as a read source (from public.jev_shadow_predictions)", () => {
    const mentions = [...code.matchAll(/[\w.]*jev_shadow_predictions/gi)].map((m) => m[0]);
    expect(mentions.length).toBeGreaterThan(0);
    for (const m of mentions) {
      // Every occurrence of the identifier must be immediately preceded by
      // "from public." somewhere on the same statement fragment. We check
      // the narrower, positive contract instead: the string never appears
      // immediately after delete/update/truncate/insert-into.
      expect(m.toLowerCase()).not.toMatch(/^(delete|update|truncate|insert)/);
    }
    expect(code).not.toMatch(/(delete\s+from|update|insert\s+into|truncate)\s+[\w.]*jev_shadow_predictions/i);
  });

  // -------------------------------------------------------------------------
  // jev_shadow_daily table
  // -------------------------------------------------------------------------

  it("creates jev_shadow_daily with the composite primary key, RLS, and revoked anon/authenticated grants", () => {
    expect(code).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.jev_shadow_daily\s*\(/i,
    );
    expect(code).toMatch(/primary\s+key\s*\(\s*day\s*,\s*task\s*,\s*question_set\s*\)/i);
    expect(code).toMatch(
      /alter\s+table\s+public\.jev_shadow_daily\s+enable\s+row\s+level\s+security/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.jev_shadow_daily\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
    );
    expect(code).toMatch(
      /grant\s+select\s*,\s*insert\s*,\s*update\s+on\s+public\.jev_shadow_daily\s+to\s+service_role/i,
    );
  });

  // -------------------------------------------------------------------------
  // jev_shadow_daily_refresh
  // -------------------------------------------------------------------------

  describe("jev_shadow_daily_refresh(p_days)", () => {
    let block = "";
    beforeAll(() => {
      block = functionBlock(code, "jev_shadow_daily_refresh");
    });

    it("is SECURITY DEFINER with an empty search_path, revoked/granted service_role only", () => {
      const h = header(block);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.jev_shadow_daily_refresh\(integer\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.jev_shadow_daily_refresh\(integer\)\s+to\s+service_role/i,
      );
    });

    it("upserts on conflict (day, task, question_set) do update", () => {
      const b = body(block);
      expect(b).toMatch(/on\s+conflict\s*\(\s*day\s*,\s*task\s*,\s*question_set\s*\)\s+do\s+update/i);
    });

    it("bounds by created_at < v_to so only complete UTC days are rolled up", () => {
      const b = body(block);
      expect(b).toMatch(/p\.created_at\s*>=\s*v_from\s+and\s+p\.created_at\s*<\s*v_to/i);
    });

    it("reads from jev_shadow_predictions and writes to jev_shadow_daily only", () => {
      const b = body(block);
      expect(b).toMatch(/from\s+public\.jev_shadow_predictions\s+p\b/i);
      expect(b).toMatch(/insert\s+into\s+public\.jev_shadow_daily/i);
    });
  });

  // -------------------------------------------------------------------------
  // jev_shadow_agreement_rollup
  // -------------------------------------------------------------------------

  describe("jev_shadow_agreement_rollup(p_days)", () => {
    let block = "";
    beforeAll(() => {
      block = functionBlock(code, "jev_shadow_agreement_rollup");
    });

    it("is STABLE, SECURITY DEFINER with an empty search_path, revoked/granted service_role only", () => {
      const h = header(block);
      expect(h).toMatch(/\bstable\b/i);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.jev_shadow_agreement_rollup\(integer\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.jev_shadow_agreement_rollup\(integer\)\s+to\s+service_role/i,
      );
    });

    it("returns table (task, total, agreed, undecided) -- the same shape as jev_shadow_agreement", () => {
      expect(header(block)).toMatch(
        /returns\s+table\s*\(\s*task\s+text\s*,\s*total\s+bigint\s*,\s*agreed\s+bigint\s*,\s*undecided\s+bigint\s*\)/i,
      );
    });

    it("unions historical (jev_shadow_daily) with live (jev_shadow_predictions) rows", () => {
      const b = body(block);
      expect(b).toMatch(/from\s+public\.jev_shadow_daily\s+d\b/i);
      expect(b).toMatch(/from\s+public\.jev_shadow_predictions\s+p\b/i);
      expect(b).toMatch(/union\s+all/i);
    });
  });

  // -------------------------------------------------------------------------
  // ops_exhaust_prune
  // -------------------------------------------------------------------------

  describe("ops_exhaust_prune(...)", () => {
    let block = "";
    beforeAll(() => {
      block = functionBlock(code, "ops_exhaust_prune");
    });

    it("is SECURITY DEFINER with an empty search_path, revoked/granted service_role only", () => {
      const h = header(block);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.ops_exhaust_prune\(interval\s*,\s*interval\s*,\s*integer\s*,\s*integer\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.ops_exhaust_prune\(interval\s*,\s*interval\s*,\s*integer\s*,\s*integer\)\s+to\s+service_role/i,
      );
    });

    it("signature defaults are 14 days / 3 days, and the runtime floors are 7 days / 1 day inside greatest(", () => {
      const h = header(block);
      expect(h).toMatch(/p_cron_keep\s+interval\s+default\s+interval\s*'14\s+days'/i);
      expect(h).toMatch(/p_net_keep\s+interval\s+default\s+interval\s*'3\s+days'/i);
      const b = body(block);
      expect(b).toMatch(/greatest\([\s\S]*?interval\s*'7\s+days'\s*\)/i);
      expect(b).toMatch(/greatest\([\s\S]*?interval\s*'1\s+day'\s*\)/i);
    });

    it("guards both tables with to_regclass, and net additionally with has_table_privilege(DELETE)", () => {
      const b = body(block);
      expect(b).toMatch(/to_regclass\(\s*'cron\.job_run_details'\s*\)\s+is\s+not\s+null/i);
      expect(b).toMatch(/to_regclass\(\s*'net\._http_response'\s*\)\s+is\s+not\s+null/i);
      expect(b).toMatch(/has_table_privilege\(\s*'net\._http_response'\s*,\s*'DELETE'\s*\)/i);
    });

    it("batches the cron delete with a LIMIT and an exit condition bounded by a max-batches counter", () => {
      const b = body(block);
      expect(b).toMatch(/limit\s+v_batch/i);
      expect(b).toMatch(/exit\s+when[^;]*v_i\s*>=\s*v_max/i);
    });

    it("never touches jev_shadow_predictions or any public table (system exhaust only)", () => {
      const b = body(block);
      expect(b).not.toMatch(/public\./i);
    });
  });

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------

  it("schedules jev-shadow-daily and ops-exhaust-prune with exact names/cron expressions, guarded and idempotent", () => {
    expect(code).toMatch(/if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+pg_catalog\.pg_extension\s+where\s+extname\s*=\s*'pg_cron'\s*\)/i);
    expect(code).toMatch(/raise\s+notice/i);

    expect(code).toMatch(
      /if\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'jev-shadow-daily'\s*\)\s*then\s*\n?\s*perform\s+cron\.unschedule\(\s*'jev-shadow-daily'\s*\)/i,
    );
    expect(code).toMatch(
      /cron\.schedule\(\s*'jev-shadow-daily'\s*,\s*'20\s+0\s+\*\s+\*\s+\*'/i,
    );

    expect(code).toMatch(
      /if\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'ops-exhaust-prune'\s*\)\s*then\s*\n?\s*perform\s+cron\.unschedule\(\s*'ops-exhaust-prune'\s*\)/i,
    );
    expect(code).toMatch(
      /cron\.schedule\(\s*'ops-exhaust-prune'\s*,\s*'40\s+4\s+\*\s+\*\s+\*'/i,
    );
  });

  it("runs the one-off backfill jev_shadow_daily_refresh(400)", () => {
    expect(code).toMatch(/select\s+public\.jev_shadow_daily_refresh\(\s*400\s*\)\s*;/i);
  });
});

// ---------------------------------------------------------------------------
// Live integration checks — opt-in via SUPABASE_LOCAL_URL (mirrors
// 058-finance-hardening.test.ts's pattern). Not run by default: this repo's
// node_modules does not carry the `pg` driver, so this suite is dormant
// unless an operator sets SUPABASE_LOCAL_URL AND installs `pg`. The
// behaviour it pins was independently verified with a manual psql dry run
// (see docs/migration-guide.md's 081 section) — that dry run is the actual
// gate for this change; this block exists so the same assertions become an
// automated regression test the moment `pg` is available.
// ---------------------------------------------------------------------------

const SUPABASE_LOCAL_URL = process.env.SUPABASE_LOCAL_URL;
const LIVE = Boolean(SUPABASE_LOCAL_URL);

describe.runIf(LIVE)("migration 081 (live against SUPABASE_LOCAL_URL)", () => {
  type PgRow = Record<string, unknown>;
  type PgClient = {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: PgRow[] }>;
    end: () => Promise<void>;
    connect: () => Promise<void>;
  };

  let client!: PgClient;

  beforeAll(async () => {
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
    await client.connect();

    await client.query(read(resolve(MIGRATIONS_DIR, "061_jev_shadow.sql")));

    await client.query(`
      create schema if not exists cron;
      create table if not exists cron.job_run_details(
        runid bigserial primary key, jobid bigint, start_time timestamptz,
        end_time timestamptz, status text, return_message text);
      create schema if not exists net;
      create table if not exists net._http_response(
        id bigserial primary key, created timestamptz not null default now(), status_code int);
    `);

    const today = new Date();
    const day = (offset: number) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - offset);
      return d.toISOString();
    };

    await client.query(
      `insert into public.sources (name, slug, url, rss_url, bias)
       values ('081 Test Source', '081-test-source', 'https://example.com', 'https://example.com/rss', 'center')
       on conflict (slug) do nothing`,
    );

    // Seed predictions across 4 UTC days (3 complete + today), two
    // question_sets, agree null/true/false.
    for (let i = 0; i < 4; i += 1) {
      const created = day(3 - i);
      await client.query(
        `insert into public.jev_shadow_predictions
           (task, subject_type, subject_id, state_hash, jev_answer, jev_prob,
            baseline_answer, agree, latency_ms, input_tokens, created_at)
         values
           ('politics','article', $1, 'h', $2::jsonb, 0.9, 'true', true, 100, 500, $3::timestamptz),
           ('politics','article', $4, 'h', $5::jsonb, 0.2, 'false', false, 100, 500, $3::timestamptz),
           ('topic','article', $6, 'h', $7::jsonb, null, 'unknown', null, 100, 500, $3::timestamptz)`,
        [
          `081-a-${i}`,
          JSON.stringify({ question_set: "qs1" }),
          created,
          `081-b-${i}`,
          JSON.stringify({ question_set: "qs1" }),
          `081-c-${i}`,
          JSON.stringify({ question_set: "qs2" }),
        ],
      );
    }

    await client.query(
      `insert into cron.job_run_details (jobid, start_time, end_time, status)
       values (1, now() - interval '20 days', now() - interval '20 days', 'succeeded'),
              (1, now() - interval '5 days', now() - interval '5 days', 'succeeded')`,
    );
    await client.query(
      `insert into net._http_response (created, status_code)
       values (now() - interval '4 days', 200),
              (now() - interval '1 hour', 200)`,
    );

    await client.query(read(resolve(MIGRATIONS_DIR, MIGRATION)));
    await client.query(read(resolve(MIGRATIONS_DIR, MIGRATION))); // apply twice: idempotent
  }, 120_000);

  afterAll(async () => {
    await client?.end();
  });

  it("rolls up complete days only, not today", async () => {
    const { rows } = await client.query(
      `select count(*)::int as n from public.jev_shadow_daily where day = (now() at time zone 'utc')::date`,
    );
    expect(rows[0]?.n).toBe(0);
    const { rows: hist } = await client.query(`select count(*)::int as n from public.jev_shadow_daily`);
    expect(Number(hist[0]?.n)).toBeGreaterThan(0);
  });

  it("jev_shadow_agreement_rollup(7) totals equal a raw count over the same window", async () => {
    const { rows: rollup } = await client.query(
      `select task, total, agreed, undecided from public.jev_shadow_agreement_rollup(7) order by task`,
    );
    const { rows: raw } = await client.query(
      `select task, count(*) filter (where agree is not null)::bigint as total,
              count(*) filter (where agree)::bigint as agreed,
              count(*) filter (where agree is null)::bigint as undecided
         from public.jev_shadow_predictions
        where created_at >= now() - interval '7 days'
        group by task order by task`,
    );
    expect(rollup.map((r) => String(r.total))).toEqual(raw.map((r) => String(r.total)));
    expect(rollup.map((r) => String(r.agreed))).toEqual(raw.map((r) => String(r.agreed)));
  });

  it("prunes only the 20-day-old cron row, keeps the 5-day-old one", async () => {
    const { rows } = await client.query(`select * from public.ops_exhaust_prune()`);
    expect(Number(rows[0]?.cron_deleted)).toBe(1);
    const { rows: remaining } = await client.query(`select count(*)::int as n from cron.job_run_details`);
    expect(remaining[0]?.n).toBe(1);
  });

  it("prunes only the 4-day-old net row, keeps the 1-hour-old one", async () => {
    const { rows: remaining } = await client.query(`select count(*)::int as n from net._http_response`);
    expect(remaining[0]?.n).toBe(1);
  });

  it("never changes the jev_shadow_predictions row count", async () => {
    const before = await client.query(`select count(*)::int as n from public.jev_shadow_predictions`);
    await client.query(`select * from public.ops_exhaust_prune()`);
    const after = await client.query(`select count(*)::int as n from public.jev_shadow_predictions`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("ops_exhaust_prune with a tiny p_cron_keep still floors at 7 days", async () => {
    await client.query(
      `insert into cron.job_run_details (jobid, start_time, end_time, status)
       values (1, now() - interval '5 days', now() - interval '5 days', 'succeeded')`,
    );
    await client.query(`select * from public.ops_exhaust_prune(interval '1 hour')`);
    const { rows } = await client.query(
      `select count(*)::int as n from cron.job_run_details where start_time > now() - interval '7 days'`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it("a second refresh gives the same values (idempotent)", async () => {
    const first = await client.query(
      `select public.jev_shadow_daily_refresh(400) as n`,
    );
    const second = await client.query(
      `select public.jev_shadow_daily_refresh(400) as n`,
    );
    expect(first.rows[0]?.n).toEqual(second.rows[0]?.n);
  });
});
