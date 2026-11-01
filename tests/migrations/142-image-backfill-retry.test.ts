import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 142 ("image_backfill_retry"), h15-images-2.
//
// The image-consumer parks an article after IMG_BACKFILL_MAX_ATTEMPTS (5) failed
// og:image fetches, but nothing ever re-sends an article after its first failure:
// the only enqueue is the AFTER INSERT trigger of migration 025, so 7,464 articles of
// the last ten days sat at attempts = 1 and the park branch could not be reached.
// 142 adds public.image_backfill_requeue(p_limit), an hourly pg_cron job that re-sends
// articles still image-less after 1 to 4 attempts (last tried more than 2 hours ago,
// created within 7 days) onto the pgmq queue, newest first, skipping rows already
// queued. It writes no article row and adds no index.
//
// This file pins: the single 142_ file, one transaction with a lock_timeout, the
// function's signature and body predicates, the clamp, the anti-duplicate guard,
// the absence of any DML on public.*, index, ALTER or DROP, the privilege set, the
// idempotent cron block (skip without pg_cron, unschedule-if-exists, schedule by
// name, no other job touched), the ledger row, the header sections, and the parity
// with supabase/functions/image-consumer/index.ts (queue name, attempt cap, payload
// key, park horizon) and the doc comments that used to promise a resweep.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE = "142_image_backfill_retry.sql";
const MIGRATION_142 = resolve(MIGRATIONS_DIR, FILE);
const CONSUMER = resolve(ROOT, "supabase", "functions", "image-consumer", "index.ts");
const ARCHITECTURE = resolve(ROOT, "docs", "architecture.md");

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Code with single-quoted string literals blanked out (comments already stripped). */
function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/** norm() with the padding inside parentheses removed, so a wrapped call compares equal to a one-line one. */
function tight(sql: string): string {
  return norm(sql).replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

const sql = readFileSync(MIGRATION_142, "utf8");
const code = stripSqlComments(sql);
const n = norm(sql);
/** Everything before the transaction: the header comment block. */
const header = sql.slice(0, sql.search(/^begin;/m));

const FN = "public.image_backfill_requeue";
const FN_SIG = `${FN}(integer)`;

const fnBodyMatch = /create or replace function public\.image_backfill_requeue\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\s+as \$fn\$([\s\S]*?)\$fn\$;/i.exec(code);
const fnArgs = norm(fnBodyMatch?.[1] ?? "");
const fnAttrs = norm(fnBodyMatch?.[2] ?? "");
const body = tight(fnBodyMatch?.[3] ?? "");

const cronBlock = /do \$cron\$([\s\S]*?)\$cron\$;/i.exec(code)?.[1] ?? "";
const cron = norm(cronBlock);
const SCHEDULED_N = Number(/select public\.image_backfill_requeue\((\d+)\);/.exec(cron)?.[1]);

const consumer = readFileSync(CONSUMER, "utf8");
const consumerHeader = consumer.slice(0, consumer.indexOf("\nimport "));

describe("142 image_backfill_retry: file, ledger and transaction", () => {
  it("is the only 142_ migration and has the agreed name", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("142_"));
    expect(files).toEqual([FILE]);
  });

  it("records version 142 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('142', '142_image_backfill_retry') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row the last statement", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const tail = n.slice(n.indexOf("begin;"));
    expect(
      tail.endsWith(
        "insert into supabase_migrations.schema_migrations (version, name) values ('142', '142_image_backfill_retry') on conflict do nothing; commit;",
      ),
    ).toBe(true);
  });

  it("sets a local lock_timeout of 5s right after begin", () => {
    expect(n).toContain("begin; set local lock_timeout = '5s';");
  });

  it("reloads the PostgREST schema cache before the ledger row", () => {
    expect(n).toContain("notify pgrst, 'reload schema';");
    expect(n.indexOf("notify pgrst, 'reload schema';")).toBeLessThan(
      n.indexOf("insert into supabase_migrations.schema_migrations"),
    );
  });
});

describe("142 image_backfill_retry: function signature", () => {
  it("creates or replaces exactly one function: public.image_backfill_requeue(p_limit integer default 300)", () => {
    expect([...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect(fnBodyMatch).not.toBeNull();
    expect(fnArgs).toBe("p_limit integer default 300");
  });

  it("returns integer, plpgsql, volatile, security definer, with an empty search_path", () => {
    expect(fnAttrs).toBe(
      "integer language plpgsql volatile security definer set search_path = ''",
    );
  });

  it("documents the function and names the migration", () => {
    expect(n).toMatch(/comment on function public\.image_backfill_requeue\(integer\) is '/);
    // adjacent string constants are concatenated by Postgres: join them before looking for phrases
    const literals = /comment on function public\.image_backfill_requeue\(integer\) is\s*((?:\s*'(?:[^']|'')*')+)\s*;/.exec(code)?.[1] ?? "";
    const doc = [...literals.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]).join("");
    expect(doc).toContain("migration 142");
    expect(doc).toContain("service_role only");
    expect(doc).toContain("p_limit");
  });
});

describe("142 image_backfill_retry: function body", () => {
  it("clamps the limit to 1..1000 with a null falling back to 300", () => {
    expect(body).toContain("v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 1000);");
  });

  it("selects only image-less articles with 1 to 4 attempts, last tried over 2 hours ago, created within 7 days", () => {
    expect(body).toContain("from public.articles a");
    expect(body).toMatch(/\ba\.image_url is null\b/);
    expect(body).toContain("a.image_backfill_attempts between 1 and 4");
    expect(body).toContain("a.image_backfill_attempted_at < pg_catalog.now() - interval '2 hours'");
    expect(body).toContain("a.created_at > pg_catalog.now() - interval '7 days'");
  });

  it("orders newest first and bounds the loop with the clamped limit", () => {
    expect(body).toContain("order by a.created_at desc limit v_limit");
  });

  it("sends {article_id} to the image_backfill queue through pgmq.send", () => {
    expect(body).toContain(
      "perform pgmq.send('image_backfill', pg_catalog.jsonb_build_object('article_id', r.id));",
    );
  });

  it("skips articles already queued (the anti-duplicate guard, NULL-safe)", () => {
    expect(body).toContain(
      "a.id::text not in (select q.message ->> 'article_id' from pgmq.q_image_backfill q where q.message ->> 'article_id' is not null)",
    );
  });

  it("counts the messages it sends and returns that count", () => {
    expect(body).toMatch(/v_sent integer := 0;/);
    expect(body).toContain("v_sent := v_sent + 1;");
    expect(body).toMatch(/return v_sent; end;?$/);
  });

  it("qualifies every name (empty search_path): now() and jsonb_build_object come from pg_catalog", () => {
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bnow\s*\(/);
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bjsonb_build_object\s*\(/);
    expect(body).not.toMatch(/\bfrom\s+(?!public\.|pgmq\.)[a-z_]+\b/);
  });
});

describe("142 image_backfill_retry: additive shape (no data rewrite, no index, no DDL on existing objects)", () => {
  const bare = stripStrings(code);

  it("writes no row: no update or delete, no insert besides the ledger row, no truncate", () => {
    expect(bare).not.toMatch(/\bupdate\b/i);
    expect(bare).not.toMatch(/\bdelete\b/i);
    expect(bare).not.toMatch(/\btruncate\b/i);
    const inserts = [...bare.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect(body).not.toMatch(/\binsert\b/i);
  });

  it("creates no index, table, trigger, view or extension, and alters or drops nothing", () => {
    expect(bare).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(bare).not.toMatch(/\bconcurrently\b/i);
    expect(bare).not.toMatch(/\bcreate\s+(table|trigger|view|materialized|extension|policy|sequence)\b/i);
    expect(bare).not.toMatch(/\balter\b/i);
    expect(bare).not.toMatch(/\bdrop\b/i);
  });

  it("touches no table other than public.articles (read) and the pgmq queue table (read)", () => {
    const tables = [...body.matchAll(/\b(?:from|join)\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(tables.sort()).toEqual(["pgmq.q_image_backfill", "public.articles"]);
    expect(body).not.toMatch(/\bclusters\b/);
  });
});

describe("142 image_backfill_retry: privileges", () => {
  it("revokes everything from public, anon and authenticated, then grants execute to service_role only", () => {
    expect(n).toContain(`revoke all on function ${FN_SIG} from public, anon, authenticated;`);
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual([`grant execute on function ${FN_SIG} to service_role;`]);
  });

  it("revokes before it grants", () => {
    expect(n.indexOf("revoke all on function")).toBeLessThan(n.indexOf("grant execute on function"));
  });

  it("grants nothing on pgmq and no default privileges (the 024-028 tripwire stays green)", () => {
    const leak = /grant[^;]*\bpgmq\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i;
    expect(leak.test(code)).toBe(false);
    for (const m of code.matchAll(/\bgrant\b[^;]*;/gi)) {
      expect(m[0]).not.toMatch(/\bpgmq\b/i);
      expect(/\bto\s+([^;]*);/i.exec(m[0])?.[1]?.trim()).toBe("service_role");
    }
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("142 image_backfill_retry: pg_cron job", () => {
  it("is one DO block that skips with a notice when pg_cron is not installed", () => {
    expect([...code.matchAll(/\bdo\s+\$\w*\$/gi)]).toHaveLength(1);
    expect(cron).toContain("if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then");
    expect(cron).toContain("raise notice '142: pg_cron missing, skipping the image-backfill-requeue schedule.'; return; end if;");
  });

  it("unschedules an existing job of the same name, then schedules it hourly at minute 17", () => {
    expect(cron).toContain(
      "if exists (select 1 from cron.job where jobname = 'image-backfill-requeue') then perform cron.unschedule('image-backfill-requeue'); end if;",
    );
    expect(cron).toContain("perform cron.schedule('image-backfill-requeue', '17 * * * *',");
    expect(cron).toMatch(
      /\$sql\$ set statement_timeout = '60s'; select public\.image_backfill_requeue\(\d+\); \$sql\$\);/,
    );
    const iSkip = cron.indexOf("pg_cron missing");
    const iUnsched = cron.indexOf("cron.unschedule");
    const iSched = cron.indexOf("cron.schedule");
    expect(iSkip).toBeGreaterThan(-1);
    expect(iUnsched).toBeGreaterThan(iSkip);
    expect(iSched).toBeGreaterThan(iUnsched);
  });

  it("names only image-backfill-requeue in every cron call and lookup (image-drain, ingest-drain and the rest stay untouched)", () => {
    const calls = [...code.matchAll(/\bcron\.(schedule|unschedule|alter_job|schedule_in_database)\s*\(\s*'([^']+)'/gi)];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c[2]).toBe("image-backfill-requeue");
    const names = [...code.matchAll(/\bjobname\s*(?:=|in)\s*\(?\s*'([^']+)'/gi)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const nm of names) expect(nm).toBe("image-backfill-requeue");
    expect(code).not.toMatch(/image-drain|ingest-drain|cluster-drain/);
    expect(code).not.toMatch(/\bupdate\s+cron\./i);
    expect(code).not.toMatch(/\bdelete\s+from\s+cron\./i);
    expect(code).not.toMatch(/\bcron\.job_run_details\b/i);
  });

  it("schedules a bounded batch: 1 <= N <= 300, inside the function's 1000 clamp, and the header states the cost", () => {
    expect(Number.isInteger(SCHEDULED_N)).toBe(true);
    expect(SCHEDULED_N).toBeGreaterThanOrEqual(1);
    expect(SCHEDULED_N).toBeLessThanOrEqual(300);
    expect(header).toContain(`≤ ${SCHEDULED_N} extra og:image fetches per hour (≤ 24·${SCHEDULED_N}`);
  });
});

describe("142 image_backfill_retry: header documents the evidence and the way back", () => {
  it.each([
    ["WHY"],
    ["STEP 0"],
    ["EXPLAIN"],
    ["NO NEW INDEX"],
    ["VERIFY"],
    ["ROLLBACK"],
  ])("has a %s section", (label) => {
    expect(header).toMatch(new RegExp(`^-- ${label}\\b`, "m"));
  });

  it("records both local dry runs", () => {
    expect(header).toMatch(/^-- DRY RUNS \(x2\)/m);
    expect(header).toMatch(/run 1/);
    expect(header).toMatch(/run 2/);
    expect(header).toContain("INSERT 0 1");
    expect(header).toContain("INSERT 0 0");
  });

  it("records the production EXPLAIN (plan node, buffers, execution time) next to the no-index decision", () => {
    expect(header).toMatch(/Index Scan using idx_articles_created_at/);
    expect(header).toMatch(/Buffers: shared hit=\d+/);
    expect(header).toMatch(/Execution Time: [\d.]+ ms/);
  });

  it("states the retry budget: at most 4 more tries, parked on the 5th failure, queued rows skipped, null attempted_at excluded", () => {
    expect(header).toMatch(/at most 4 more tries/i);
    expect(header).toMatch(/5th failure/);
    expect(header).toMatch(/already queued/i);
    expect(header).toMatch(/attempted_at is null/i);
  });

  it("gives the exact rollback statements", () => {
    expect(header).toContain("select cron.unschedule('image-backfill-requeue');");
    expect(header).toContain("drop function public.image_backfill_requeue(integer);");
    expect(header).toContain("delete from supabase_migrations.schema_migrations where version = '142';");
  });
});

describe("142 image_backfill_retry: parity with supabase/functions/image-consumer/index.ts", () => {
  const queueName = /const QUEUE_NAME = "([^"]+)";/.exec(consumer)?.[1];
  const maxAttempts = Number(/const IMG_BACKFILL_MAX_ATTEMPTS = (\d+);/.exec(consumer)?.[1]);
  const parkDays = Number(/const IMG_BACKFILL_PARK_MS = (\d+) \* 24 \* 3600 \* 1000;/.exec(consumer)?.[1]);
  const jobKey = /interface ImageJob \{\s*([a-z_]+)\??: string;/.exec(consumer)?.[1];

  it("sends to the queue the consumer drains", () => {
    expect(queueName).toBe("image_backfill");
    expect(body).toContain(`pgmq.send('${queueName}'`);
    expect(body).toContain(`pgmq.q_${queueName} q`);
  });

  it("re-sends attempts 1..(IMG_BACKFILL_MAX_ATTEMPTS - 1): the 5th failure parks the row", () => {
    expect(maxAttempts).toBe(5);
    expect(body).toContain(`a.image_backfill_attempts between 1 and ${maxAttempts - 1}`);
    expect(consumer).toContain("const shouldPark = next >= IMG_BACKFILL_MAX_ATTEMPTS;");
  });

  it("parks by pushing attempted_at into the future, which the 2-hour gate excludes; the creation window equals the park horizon", () => {
    expect(consumer).toContain("new Date(Date.now() + IMG_BACKFILL_PARK_MS).toISOString()");
    expect(parkDays).toBe(7);
    expect(body).toContain(`interval '${parkDays} days'`);
  });

  it("uses the payload key the consumer reads", () => {
    expect(jobKey).toBe("article_id");
    expect(consumer).toContain("msg.message?.article_id");
    expect(body).toContain(`pg_catalog.jsonb_build_object('${jobKey}', r.id)`);
  });
});

describe("142 image_backfill_retry: comments no longer promise a resweep that does not exist", () => {
  it("the image-consumer header names the cron job and drops the false AFTER UPDATE / resweep claim", () => {
    expect(consumerHeader.length).toBeGreaterThan(200);
    expect(consumerHeader).not.toContain("AFTER UPDATE trigger");
    expect(consumerHeader).not.toMatch(/resweep/i);
    expect(consumerHeader).toContain("image-backfill-requeue");
    expect(consumerHeader).toContain("142");
  });

  it("no source file anywhere in the consumer still says resweep", () => {
    expect(consumer).not.toMatch(/resweep/i);
    expect(consumer).not.toContain("AFTER UPDATE trigger");
  });

  it("docs/architecture.md lists the Image requeue stage and mentions the retry in the Image drain row", () => {
    const arch = readFileSync(ARCHITECTURE, "utf8");
    expect(arch).not.toMatch(/resweep/i);
    const rows = arch.split("\n").filter((l) => l.startsWith("|"));
    const requeue = rows.find((l) => l.startsWith("| Image requeue |"));
    expect(requeue).toBeDefined();
    expect(requeue).toContain("image-backfill-requeue");
    expect(requeue).toContain("`17 * * * *`");
    expect(requeue).toContain(`image_backfill_requeue(${SCHEDULED_N})`);
    expect(requeue).toMatch(/migration 142/i);
    expect(requeue).toMatch(/2 h/);
    expect(requeue).toMatch(/7 d/);
    expect(requeue).toMatch(/park/i);
    const drain = rows.find((l) => l.startsWith("| Image drain |"));
    expect(drain).toBeDefined();
    expect(drain).toContain("Image requeue");
  });
});
